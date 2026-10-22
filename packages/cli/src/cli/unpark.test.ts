import { createOctokitQueueClient } from '@on-par/factory-core/internal';
import { describe, expect, it, vi } from 'vitest';

import { renderUnparkLines } from './queue-output.js';
import { unparkClient } from './test-support/unpark-client.js';
import { formatUnparkCycle, runUnpark, runUnparkBatch, toUnparkBatchJson } from './unpark.js';

const names = (...n: string[]) => n.map((name) => ({ name }));

/** Octokit mock for lane `ops`: #23 queued at order 23, #24 kept order:24 after `factory:queued` was removed, #12 parked. */
function opsOctokit() {
  const issues = {
    createLabel: vi.fn(async () => ({})),
    addLabels: vi.fn(async () => ({})),
    removeLabel: vi.fn(async () => ({})),
    listForRepo: vi.fn(async () => ({
      data: [
        { number: 23, labels: names('factory:queued', 'factory:lane:ops', 'factory:order:23') },
        { number: 24, labels: names('factory:lane:ops', 'factory:order:24') },
        { number: 12, labels: names('factory:parked', 'factory:lane:ops') },
      ],
    })),
    listLabelsOnIssue: vi.fn(async () => ({ data: names('factory:parked', 'factory:lane:ops') })),
  };
  return { issues, octokit: { rest: { issues } } as never };
}

describe('unpark order-label-kept-after-queued-removed', () => {
  it('assigns the next free position, never the order label an open non-queued issue kept', async () => {
    const { issues, octokit } = opsOctokit();

    const json = await runUnpark({ client: createOctokitQueueClient(octokit), owner: 'o', repo: 'r', issue: 12 });

    expect(json).toMatchObject({ action: 'unpark', issue: 12, lane: 'ops', order: 25 });
    expect(json.collision).toEqual({ order: 24, heldBy: [24] });
    const added = (issues.addLabels.mock.calls as any[]).flatMap(([a]) => a.labels);
    expect(added).toContain('factory:order:25');
    expect(added).not.toContain('factory:order:24');
    expect(renderUnparkLines(json).join('\n')).toContain('factory:order:24 held by #24');
  });
});

const PARKED = ['factory:parked', 'factory:lane:bugfix'];

/** In-memory batch harness; records the issue number of every `factory:queued` add, in call order. */
function batch(labelsByIssue: Array<[number, string[]]>, bodies: Record<number, string> = {}) {
  const labels = new Map(labelsByIssue);
  const client = unparkClient(labels);
  const queuedOrder: number[] = [];
  const writes = vi.fn();
  const addLabels = client.addLabels;
  client.addLabels = async (args) => {
    writes();
    if (args.labels.includes('factory:queued')) queuedOrder.push(args.issue_number);
    return addLabels(args);
  };
  const removeLabel = client.removeLabel;
  client.removeLabel = async (args) => {
    writes();
    return removeLabel(args);
  };
  const base = {
    client,
    owner: 'o',
    repo: 'r',
    readIssueBody: async (n: number) => bodies[n] ?? '',
    listBlockedBy: async () => [],
  };
  return { labels, queuedOrder, writes, base };
}

const orderOf = (labels: Map<number, string[]>, n: number) =>
  Number((labels.get(n) ?? []).find((l) => l.startsWith('factory:order:'))?.slice('factory:order:'.length));

describe('runUnparkBatch', () => {
  it('bulk unpark queues a chain in prerequisite order (10/19 #3175 to #3181 to #3176)', async () => {
    const h = batch(
      [
        [3176, PARKED],
        [3181, PARKED],
        [3175, PARKED],
      ],
      { 3176: 'Prerequisite: #3181', 3181: 'Prerequisite: #3175' },
    );
    const onUnparked = vi.fn();

    const outcome = await runUnparkBatch({ ...h.base, issues: [3176, 3181, 3175], onUnparked });

    expect(outcome.kind).toBe('done');
    if (outcome.kind !== 'done') return;
    expect(outcome.order).toEqual([3175, 3181, 3176]);
    expect(h.queuedOrder).toEqual([3175, 3181, 3176]);
    const orders = h.queuedOrder.map((n) => orderOf(h.labels, n));
    expect(orders[0]).toBeLessThan(orders[1]);
    expect(orders[1]).toBeLessThan(orders[2]);
    expect(onUnparked.mock.calls.map(([r]) => r.issue)).toEqual([3175, 3181, 3176]);
  });

  it('refuses a cycle and touches no label', async () => {
    const h = batch(
      [
        [10, PARKED],
        [11, PARKED],
      ],
      { 10: 'Prerequisite: #11', 11: 'Prerequisite: #10' },
    );

    const outcome = await runUnparkBatch({ ...h.base, issues: [10, 11] });

    expect(outcome.kind).toBe('cycle');
    if (outcome.kind !== 'cycle') return;
    expect(formatUnparkCycle(outcome.cycle)).toBe('#10 -> #11 -> #10');
    expect(h.writes).not.toHaveBeenCalled();
  });

  it('continues past a not-parked issue and reports it in the envelope', async () => {
    const h = batch([
      [1, PARKED],
      [2, ['bug']],
      [3, PARKED],
    ]);

    const outcome = await runUnparkBatch({ ...h.base, issues: [1, 2, 3] });

    if (outcome.kind !== 'done') throw new Error('expected done');
    expect(outcome.results.map((r) => r.ok)).toEqual([true, false, true]);
    expect(outcome.results[1]).toMatchObject({ ok: false, failure: { issue: 2, code: 'not-parked' } });
    expect(h.labels.get(1)).toContain('factory:queued');
    expect(h.labels.get(3)).toContain('factory:queued');
    const json = toUnparkBatchJson(outcome);
    expect(json.results).toHaveLength(3);
    expect(json.summary).toEqual({ ok: 2, failed: 1 });
  });

  it('queues nothing when an issue body cannot be read', async () => {
    const h = batch([
      [1, PARKED],
      [2, PARKED],
    ]);
    const readIssueBody = async (n: number) => {
      if (n === 2) throw new Error('boom');
      return '';
    };

    const outcome = await runUnparkBatch({ ...h.base, readIssueBody, issues: [1, 2] });

    expect(outcome).toMatchObject({ kind: 'prerequisites-unreadable', issue: 2 });
    expect(h.writes).not.toHaveBeenCalled();
  });

  it('ignores out-of-batch, closed and cross-repo prerequisites', async () => {
    const h = batch(
      [
        [1, PARKED],
        [2, PARKED],
      ],
      { 1: 'Prerequisite: #999' },
    );
    const getLabels = vi.spyOn(h.base.client, 'getIssueLabels');
    const listBlockedBy = async (n: number) =>
      n === 2
        ? [
            { number: 1, state: 'closed' as const, stateReason: null, repository: 'o/r' },
            { number: 1, state: 'open' as const, stateReason: null, repository: 'other/r' },
          ]
        : [];

    const outcome = await runUnparkBatch({ ...h.base, listBlockedBy, issues: [1, 2] });

    if (outcome.kind !== 'done') throw new Error('expected done');
    expect(outcome.order).toEqual([1, 2]);
    expect(getLabels.mock.calls.map(([a]) => a.issue_number)).not.toContain(999);
  });
});
