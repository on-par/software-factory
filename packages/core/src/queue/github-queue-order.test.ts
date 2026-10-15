// packages/core/src/queue/github-queue-order.test.ts — Duplicate factory:order positions skip, not stall, a lane (#2977).

import { describe, expect, it, vi } from 'vitest';

import {
  createGithubQueue,
  laneLabel,
  QUEUED_LABEL,
  queueOrderLabel,
  type QueueGitHubClient,
  type QueueIssue,
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

  it('skips issues that share a position and keeps claiming the rest of the lane', async () => {
    const { client } = createFakeStore(dupIssues());
    const queue = createGithubQueue({ client, owner: 'o', repo: 'r', claimantId: 'aaa-1' });

    const claim = await queue.claimNext('build');

    expect(claim?.issue).toBe(12);
  });

  it('reports a duplicate position through onOrderConflict with lane, position and both issues', async () => {
    const { client } = createFakeStore(dupIssues());
    const onOrderConflict = vi.fn();
    const queue = createGithubQueue({ client, owner: 'o', repo: 'r', claimantId: 'aaa-1', onOrderConflict });

    await queue.claimNext('build');

    expect(onOrderConflict).toHaveBeenCalledTimes(1);
    expect(onOrderConflict).toHaveBeenCalledWith({ lane: 'build', position: 5, issues: [10, 11] });
  });

  it('list() omits duplicate-position issues and reports the conflict', async () => {
    const { client } = createFakeStore(dupIssues());
    const onOrderConflict = vi.fn();
    const queue = createGithubQueue({ client, owner: 'o', repo: 'r', claimantId: 'aaa-1', onOrderConflict });

    expect(await queue.list('build')).toEqual([12]);
    expect(onOrderConflict).toHaveBeenCalledTimes(1);
  });

  it('reports all issues sharing one position and skips every one of them', async () => {
    const { client } = createFakeStore([
      { number: 3, labels: [QUEUED_LABEL, laneLabel('build'), queueOrderLabel(2)] },
      { number: 1, labels: [QUEUED_LABEL, laneLabel('build'), queueOrderLabel(2)] },
      { number: 2, labels: [QUEUED_LABEL, laneLabel('build'), queueOrderLabel(2)] },
    ]);
    const onOrderConflict = vi.fn();
    const queue = createGithubQueue({ client, owner: 'o', repo: 'r', claimantId: 'aaa-1', onOrderConflict });

    expect(await queue.list('build')).toEqual([]);
    expect(onOrderConflict).toHaveBeenCalledTimes(1);
    expect(onOrderConflict).toHaveBeenCalledWith({ lane: 'build', position: 2, issues: [1, 2, 3] });
  });

  it('claimNext returns null when every issue in the lane is in a duplicated position', async () => {
    const { client } = createFakeStore([
      { number: 1, labels: [QUEUED_LABEL, laneLabel('build'), queueOrderLabel(1)] },
      { number: 2, labels: [QUEUED_LABEL, laneLabel('build'), queueOrderLabel(1)] },
    ]);
    const queue = createGithubQueue({ client, owner: 'o', repo: 'r', claimantId: 'aaa-1' });

    expect(await queue.claimNext('build')).toBeNull();
  });
});
