// packages/core/src/queue/linear-queue-backend.test.ts — Linear QueueBackend composed from both halves (#3918).
import { describe, expect, it, vi } from 'vitest';
import { LinearTrackerSchema } from '../config/tracker-section.js';
import { toWorkKey } from '../work/work-key.js';
import { DEFAULT_CLAIM_LEASE_MS } from './github-queue.js';
import { createLinearQueueBackend, resolveLinearProjectForRepo } from './linear-queue-backend.js';
import type { LinearQueueClient } from './linear-queue.js';
import { LINEAR_LEASE_KIND, type LinearClaimLease, type LinearQueueLifecycleClient } from './linear-queue-lifecycle.js';
import { createQueueBackend } from './queue-backend.js';

const linear = LinearTrackerSchema.parse({ teamKey: 'ON', projects: { Foreman: 'o/r' } });
const NOW = 1_700_000_000_000;

interface FakeIssue {
  id: string;
  identifier: string;
  lane?: string;
  labels: Set<string>;
  state: string;
  lease?: { attachmentId: string; metadata: unknown };
}

function fake(issues: FakeIssue[]) {
  const comments: string[] = [];
  const leaseCalls: LinearClaimLease[] = [];
  const byId = (id: string) => issues.find((i) => i.id === id);
  const client: LinearQueueClient & LinearQueueLifecycleClient = {
    async listCandidates() {
      return issues
        .filter((i) => i.state === 'Todo' && i.labels.has('factory:ready'))
        .map((i) => ({
          id: i.id,
          identifier: i.identifier,
          priority: 2,
          createdAt: '2026-01-01T00:00:00Z',
          stateType: 'unstarted',
          labels: [
            ...[...i.labels].map((name) => ({ id: name, name })),
            ...(i.lane ? [{ id: i.lane, name: i.lane, group: 'lane' }] : []),
          ],
        }));
    },
    async issueLabels(id) {
      return [...(byId(id)?.labels ?? [])];
    },
    async ensureLabel(name) {
      return name;
    },
    async addLabel(id, labelId) {
      byId(id)?.labels.add(labelId);
    },
    async removeLabel(id, labelId) {
      byId(id)?.labels.delete(labelId);
    },
    async moveToState(id, state) {
      const i = byId(id);
      if (i) i.state = state;
    },
    async findIssue(identifier) {
      const i = issues.find((x) => x.identifier === identifier);
      return i
        ? {
            id: i.id,
            identifier: i.identifier,
            labels: [...i.labels].map((name) => ({ id: name, name })),
            ...(i.lease ? { lease: i.lease } : {}),
          }
        : null;
    },
    async listLeasedIssues() {
      return Promise.all(issues.filter((i) => i.lease).map((i) => client.findIssue(i.identifier))).then((r) =>
        r.filter((x) => x !== null),
      );
    },
    async addComment(_id, body) {
      comments.push(body);
    },
    async upsertLeaseAttachment(id, lease) {
      leaseCalls.push(lease);
      const i = byId(id);
      if (i) i.lease = { attachmentId: 'att', metadata: lease };
    },
    async deleteAttachment() {
      for (const i of issues) delete i.lease;
    },
  };
  return { client, comments, leaseCalls, issues };
}

const on12 = (): FakeIssue => ({
  id: 'id-12',
  identifier: 'ON-12',
  lane: 'infra',
  labels: new Set(['factory:ready']),
  state: 'Todo',
});

function setup(issues: FakeIssue[] = [on12()], now: () => number = () => NOW) {
  const f = fake(issues);
  const warn = vi.fn();
  const backend = createLinearQueueBackend({ client: f.client, linear, warn, claimantId: 'host-a-1', now });
  return { ...f, backend, warn };
}

describe('createLinearQueueBackend', () => {
  it('createQueueBackend kind linear lists ON-12 in lane infra', async () => {
    const f = fake([on12()]);
    const backend = createQueueBackend({
      kind: 'linear',
      linear: { client: f.client, linear, warn: () => undefined, claimantId: 'host-a-1' },
    });
    expect(await backend.list('infra')).toEqual(['ON-12']);
  });

  it('claimNext claims ON-12 and writes the first lease attachment', async () => {
    const { backend, issues, leaseCalls } = setup();
    const claim = await backend.claimNext('infra');
    expect(claim?.key).toBe('ON-12');
    expect(issues[0]?.labels.has('factory:claimed-by:host-a-1')).toBe(true);
    expect(leaseCalls).toEqual([
      { kind: LINEAR_LEASE_KIND, claimantId: 'host-a-1', expiresAt: NOW + DEFAULT_CLAIM_LEASE_MS },
    ]);
  });

  it('claimNext returns null when nothing is queued', async () => {
    const { backend, leaseCalls } = setup([]);
    expect(await backend.claimNext('infra')).toBeNull();
    expect(leaseCalls).toEqual([]);
  });

  it('heartbeat renews the lease written by claimNext', async () => {
    let t = NOW;
    const { backend, leaseCalls } = setup([on12()], () => t);
    await backend.claimNext('infra');
    t += 60_000;
    expect(await backend.heartbeat(toWorkKey('ON-12'))).toBe(true);
    expect(leaseCalls).toHaveLength(2);
    expect(leaseCalls[1]!.expiresAt).toBeGreaterThan(leaseCalls[0]!.expiresAt);
  });

  it('release parked adds the parked label, comments the reason and moves to the ready state', async () => {
    const { backend, issues, comments } = setup();
    await backend.claimNext('infra');
    await backend.release(toWorkKey('ON-12'), 'parked');
    expect(issues[0]?.labels.has('factory:parked')).toBe(true);
    expect(issues[0]?.labels.has('factory:claimed-by:host-a-1')).toBe(false);
    expect(comments[0]).toContain('Parked by the factory');
    expect(issues[0]?.state).toBe('Todo');
  });

  it('reap releases a claim whose lease has expired', async () => {
    const stale = on12();
    stale.state = 'In Progress';
    stale.labels.add('factory:claimed-by:host-b-2');
    stale.lease = {
      attachmentId: 'att',
      metadata: { kind: LINEAR_LEASE_KIND, claimantId: 'host-b-2', expiresAt: NOW - 1 },
    };
    const { backend, issues } = setup([stale]);
    const rows = await backend.reap();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: 'ON-12', released: true });
    expect(issues[0]?.state).toBe('Todo');
  });

  it('lanes returns the sorted distinct lanes of ready issues', async () => {
    const other: FakeIssue = { id: 'id-7', identifier: 'ON-7', labels: new Set(['factory:ready']), state: 'Todo' };
    const { backend } = setup([on12(), other]);
    expect(await backend.lanes()).toEqual(['default', 'infra']);
  });

  it('pollBlockedParks returns an empty list', async () => {
    const { backend } = setup();
    expect(await backend.pollBlockedParks()).toEqual([]);
  });
});

describe('resolveLinearProjectForRepo', () => {
  it('matches the project mapped to the repo', () => {
    expect(resolveLinearProjectForRepo(linear, 'o/r')).toBe('Foreman');
  });
  it('matches case-insensitively', () => {
    expect(resolveLinearProjectForRepo(linear, 'O/R')).toBe('Foreman');
  });
  it('returns null when no project maps to the repo', () => {
    expect(resolveLinearProjectForRepo(linear, 'x/y')).toBeNull();
  });
  it('throws naming the projects when several map to the repo', () => {
    const dup = LinearTrackerSchema.parse({ teamKey: 'ON', projects: { A: 'o/r', B: 'o/r' } });
    expect(() => resolveLinearProjectForRepo(dup, 'o/r')).toThrow(/A, B/);
  });
});
