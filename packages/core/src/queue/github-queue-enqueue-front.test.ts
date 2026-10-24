// packages/core/src/queue/github-queue-enqueue-front.test.ts — enqueueFront places issues at the front of a lane (#3552).

import { describe, expect, it } from 'vitest';

import { createGithubQueue, laneLabel, QUEUED_LABEL, queueOrderLabel, type QueueGitHubClient } from './github-queue.js';
import { fakeIssueComments } from './fake-issue-comments.js';

function createStore(
  issues: Array<{ number: number; labels: string[] }>,
  fail: { add?: (issue: number, labels: string[]) => boolean; remove?: boolean } = {},
) {
  const state = new Map<number, Set<string>>(issues.map((i) => [i.number, new Set(i.labels)]));
  const client: QueueGitHubClient = {
    async listOpenIssuesWithLabels({ labels }) {
      return [...state]
        .filter(([, set]) => labels.every((l) => set.has(l)))
        .map(([number, set]) => ({ number, labels: [...set] }));
    },
    async getIssueLabels({ issue_number }) {
      return [...(state.get(issue_number) ?? new Set<string>())];
    },
    async addLabels({ issue_number, labels }) {
      if (fail.add?.(issue_number, labels)) throw new Error(`boom on #${issue_number}`);
      const set = state.get(issue_number) ?? new Set<string>();
      for (const label of labels) set.add(label);
      state.set(issue_number, set);
    },
    async removeLabel({ issue_number, name }) {
      if (fail.remove) throw new Error('remove boom');
      state.get(issue_number)?.delete(name);
    },
    ...fakeIssueComments(),
    async ensureLabel() {
      return false;
    },
  };
  return { client, state };
}

const L = laneLabel('bugfix');
const queued = (n: number, pos: number) => ({ number: n, labels: [QUEUED_LABEL, L, queueOrderLabel(pos)] });
const orders = (state: Map<number, Set<string>>, n: number) =>
  [...(state.get(n) ?? [])].filter((l) => l.startsWith('factory:order:'));
const queueFor = (client: QueueGitHubClient) =>
  createGithubQueue({ client, owner: 'o', repo: 'r', claimantId: 'aaa-1' });

describe('enqueueFront', () => {
  it('places one issue at order 1 and shifts every other in-lane order up by one', async () => {
    const { client, state } = createStore([queued(1, 1), queued(2, 2), { number: 60, labels: [] }]);
    const res = await queueFor(client).enqueueFront('bugfix', [60]);
    expect(res.placement).toBe('front');
    expect(res.results.map((r) => [r.issue, r.outcome, r.position])).toEqual([[60, 'queued', 1]]);
    expect(orders(state, 1)).toEqual([queueOrderLabel(2)]);
    expect(orders(state, 2)).toEqual([queueOrderLabel(3)]);
    expect(orders(state, 60)).toEqual([queueOrderLabel(1)]);
    expect(state.get(60)?.has(QUEUED_LABEL)).toBe(true);
    expect(state.get(60)?.has(L)).toBe(true);
  });

  it('gives an empty lane order 1', async () => {
    const { client, state } = createStore([{ number: 60, labels: [] }]);
    const res = await queueFor(client).enqueueFront('bugfix', [60]);
    expect(res.results[0]?.position).toBe(1);
    expect(orders(state, 60)).toEqual([queueOrderLabel(1)]);
  });

  it('reports an issue that already has an order as already-queued', async () => {
    const { client, state } = createStore([queued(1, 1), queued(60, 5)]);
    const res = await queueFor(client).enqueueFront('bugfix', [60]);
    expect(res.results.map((r) => [r.outcome, r.position])).toEqual([['already-queued', 5]]);
    expect(orders(state, 1)).toEqual([queueOrderLabel(1)]);
  });

  it('falls back to the tail with a detail when a shift fails', async () => {
    const { client } = createStore([queued(1, 1), { number: 60, labels: [] }], {
      add: (issue) => issue === 1,
    });
    const res = await queueFor(client).enqueueFront('bugfix', [60]);
    expect(res.placement).toBe('tail');
    expect(res.detail).toContain('boom on #1');
    expect(res.results[0]?.outcome).toBe('queued');
  });

  it('leaves members with a malformed or multiple order label alone', async () => {
    const { client, state } = createStore([
      { number: 1, labels: [QUEUED_LABEL, L, 'factory:order:abc'] },
      { number: 2, labels: [QUEUED_LABEL, L, queueOrderLabel(2), queueOrderLabel(3)] },
      { number: 60, labels: [] },
    ]);
    await queueFor(client).enqueueFront('bugfix', [60]);
    expect(orders(state, 1)).toEqual(['factory:order:abc']);
    expect(orders(state, 2).sort()).toEqual([queueOrderLabel(2), queueOrderLabel(3)]);
  });
});
