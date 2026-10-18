// packages/core/src/queue/github-queue-order.test.ts — Duplicate factory:order positions are claimed by issue number, not skipped (#2977, #3101).

import { describe, expect, it, vi } from 'vitest';

import {
  createGithubQueue,
  formatQueueOrderConflict,
  laneLabel,
  QUEUED_LABEL,
  queueOrderLabel,
  type QueueGitHubClient,
  type QueueIssue,
  type QueueOrderConflict,
} from './github-queue.js';

function createFakeStore(issues: Array<{ number: number; labels: string[] }>) {
  const state = new Map<number, Set<string>>(issues.map((i) => [i.number, new Set(i.labels)]));
  const createdLabels = new Set<string>();
  const calls: string[] = [];

  const client: QueueGitHubClient = {
    async listOpenIssuesWithLabels({ labels }) {
      calls.push('listOpenIssuesWithLabels');
      const result: QueueIssue[] = [];
      for (const [number, labelSet] of state) {
        if (labels.every((l) => labelSet.has(l))) {
          result.push({ number, labels: [...labelSet] });
        }
      }
      return result;
    },
    async getIssueLabels({ issue_number }) {
      calls.push('getIssueLabels');
      return [...(state.get(issue_number) ?? new Set<string>())];
    },
    async addLabels({ issue_number, labels }) {
      calls.push('addLabels');
      // Yield before mutating so concurrent claimNext calls can interleave — this is
      // what makes the simulated-race tests below an actual race, not a fixed order.
      await Promise.resolve();
      const set = state.get(issue_number) ?? new Set<string>();
      for (const label of labels) set.add(label);
      state.set(issue_number, set);
    },
    async removeLabel({ issue_number, name }) {
      calls.push('removeLabel');
      state.get(issue_number)?.delete(name);
    },
    async ensureLabel({ name }) {
      calls.push('ensureLabel');
      createdLabels.add(name);
      return false;
    },
  };
  return { state, createdLabels, calls, client };
}

describe('duplicate order positions', () => {
  const dupIssues = () => [
    { number: 10, labels: [QUEUED_LABEL, laneLabel('build'), queueOrderLabel(5)] },
    { number: 11, labels: [QUEUED_LABEL, laneLabel('build'), queueOrderLabel(5)] },
    { number: 12, labels: [QUEUED_LABEL, laneLabel('build'), queueOrderLabel(6)] },
  ];

  it('claims the lowest issue number among those sharing the first position', async () => {
    const { client } = createFakeStore(dupIssues());
    const queue = createGithubQueue({ client, owner: 'o', repo: 'r', claimantId: 'aaa-1' });

    expect((await queue.claimNext('build'))?.issue).toBe(10);
  });

  it('claims issues sharing a position by issue number, lowest first, then the next position', async () => {
    const { client } = createFakeStore(dupIssues());
    const queue = createGithubQueue({ client, owner: 'o', repo: 'r', claimantId: 'aaa-1' });

    const claimed: Array<number | undefined> = [];
    for (let i = 0; i < 3; i++) claimed.push((await queue.claimNext('build'))?.issue);

    expect(claimed).toEqual([10, 11, 12]);
  });

  it('reports a duplicate position through onOrderConflict with lane, position and both issues', async () => {
    const { client } = createFakeStore(dupIssues());
    const onOrderConflict = vi.fn();
    const queue = createGithubQueue({ client, owner: 'o', repo: 'r', claimantId: 'aaa-1', onOrderConflict });

    await queue.claimNext('build');

    expect(onOrderConflict).toHaveBeenCalledTimes(1);
    expect(onOrderConflict).toHaveBeenCalledWith({ lane: 'build', position: 5, issues: [10, 11] });
  });

  it('list() keeps duplicate-position issues in issue-number order and reports the conflict', async () => {
    const { client } = createFakeStore(dupIssues());
    const onOrderConflict = vi.fn();
    const queue = createGithubQueue({ client, owner: 'o', repo: 'r', claimantId: 'aaa-1', onOrderConflict });

    expect(await queue.list('build')).toEqual([10, 11, 12]);
    expect(onOrderConflict).toHaveBeenCalledTimes(1);
  });

  it('sorts three issues at one position ascending and reports them once', async () => {
    const { client } = createFakeStore([
      { number: 3, labels: [QUEUED_LABEL, laneLabel('build'), queueOrderLabel(2)] },
      { number: 1, labels: [QUEUED_LABEL, laneLabel('build'), queueOrderLabel(2)] },
      { number: 2, labels: [QUEUED_LABEL, laneLabel('build'), queueOrderLabel(2)] },
    ]);
    const onOrderConflict = vi.fn();
    const queue = createGithubQueue({ client, owner: 'o', repo: 'r', claimantId: 'aaa-1', onOrderConflict });

    expect(await queue.list('build')).toEqual([1, 2, 3]);
    expect(onOrderConflict).toHaveBeenCalledTimes(1);
    expect(onOrderConflict).toHaveBeenCalledWith({ lane: 'build', position: 2, issues: [1, 2, 3] });
  });

  it('claimNext returns the lowest issue when every issue in the lane shares one position', async () => {
    const { client } = createFakeStore([
      { number: 2, labels: [QUEUED_LABEL, laneLabel('build'), queueOrderLabel(1)] },
      { number: 1, labels: [QUEUED_LABEL, laneLabel('build'), queueOrderLabel(1)] },
    ]);
    const queue = createGithubQueue({ client, owner: 'o', repo: 'r', claimantId: 'aaa-1' });

    expect((await queue.claimNext('build'))?.issue).toBe(1);
  });
});

describe('formatQueueOrderConflict', () => {
  it('names the lane, label and every issue', () => {
    expect(formatQueueOrderConflict({ lane: 'dup', position: 1, issues: [3, 4] })).toBe(
      'lane dup: issues #3, #4 share factory:order:1 — claimed in issue-number order | repair: give each a unique order label',
    );
  });

  it.each([
    ['missing-order-label', 'has no factory:order:<n> label'],
    ['multiple-order-labels', 'has multiple factory:order labels'],
    ['malformed-order-label', 'has a malformed factory:order label'],
  ] as const)('describes a skipped issue (%s)', (reason, text) => {
    const line = formatQueueOrderConflict({ lane: 'ops', position: null, issues: [7], reason });
    expect(line).toContain('lane ops');
    expect(line).toContain('#7');
    expect(line).toContain(text);
    expect(line).toContain('skipped');
  });
});

describe('missing, multiple or malformed order labels (#3192)', () => {
  it('list skips an issue with no order label and reports it (#3192)', async () => {
    const { client } = createFakeStore([
      { number: 1, labels: [QUEUED_LABEL, laneLabel('build')] },
      { number: 2, labels: [QUEUED_LABEL, laneLabel('build'), queueOrderLabel(1)] },
    ]);
    const seen: QueueOrderConflict[] = [];
    const queue = createGithubQueue({
      client,
      owner: 'o',
      repo: 'r',
      claimantId: 'aaa-1',
      onOrderConflict: (c) => seen.push(c),
    });

    expect(await queue.list('build')).toEqual([2]);
    expect(seen).toEqual([{ lane: 'build', position: null, issues: [1], reason: 'missing-order-label' }]);
  });

  it.each([
    [[QUEUED_LABEL, laneLabel('build'), 'factory:order:0'], 'malformed-order-label'],
    [[QUEUED_LABEL, laneLabel('build'), queueOrderLabel(1), queueOrderLabel(2)], 'multiple-order-labels'],
  ])('claimNext skips malformed or multiple order labels and claims the valid issue', async (labels, reason) => {
    const { client } = createFakeStore([
      { number: 1, labels },
      { number: 2, labels: [QUEUED_LABEL, laneLabel('build'), queueOrderLabel(1)] },
    ]);
    const seen: QueueOrderConflict[] = [];
    const queue = createGithubQueue({
      client,
      owner: 'o',
      repo: 'r',
      claimantId: 'aaa-1',
      onOrderConflict: (c) => seen.push(c),
    });

    const claimed = await queue.claimNext('build');

    expect(claimed?.issue).toBe(2);
    expect(seen[0].reason).toBe(reason);
  });

  it('claimNext returns null and reports a lane holding only a malformed issue', async () => {
    const { client } = createFakeStore([{ number: 1, labels: [QUEUED_LABEL, laneLabel('build')] }]);
    const seen: QueueOrderConflict[] = [];
    const queue = createGithubQueue({
      client,
      owner: 'o',
      repo: 'r',
      claimantId: 'aaa-1',
      onOrderConflict: (c) => seen.push(c),
    });

    expect(await queue.claimNext('build')).toBeNull();
    expect(seen).toEqual([{ lane: 'build', position: null, issues: [1], reason: 'missing-order-label' }]);
  });
});
