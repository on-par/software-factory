// packages/core/src/queue/github-queue-enqueue-after.test.ts — enqueueAfter places decomposed children behind the parent's order (#3539).

import { describe, expect, it } from 'vitest';

import {
  createGithubQueue,
  IN_PROGRESS_LABEL,
  laneLabel,
  QUEUED_LABEL,
  queueOrderLabel,
  type QueueGitHubClient,
} from './github-queue.js';
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
const P = 50;
const parent = { number: P, labels: [IN_PROGRESS_LABEL, L, queueOrderLabel(4)] };
const orders = (state: Map<number, Set<string>>, n: number) =>
  [...(state.get(n) ?? [])].filter((l) => l.startsWith('factory:order:'));
const queueFor = (client: QueueGitHubClient) =>
  createGithubQueue({ client, owner: 'o', repo: 'r', claimantId: 'aaa-1' });

describe('enqueueAfter', () => {
  it("places children right after the parent's order and shifts every later in-lane issue up", async () => {
    const { client, state } = createStore([
      queued(1, 1),
      queued(2, 2),
      queued(3, 3),
      parent,
      queued(11, 5),
      queued(12, 6),
      { number: 60, labels: [] },
      { number: 61, labels: [] },
      { number: 62, labels: [] },
    ]);
    const queue = queueFor(client);

    const res = await queue.enqueueAfter('bugfix', P, [60, 61, 62]);

    expect(res.placement).toBe('after-parent');
    expect(res.results.map((r) => [r.issue, r.outcome, r.position])).toEqual([
      [60, 'queued', 5],
      [61, 'queued', 6],
      [62, 'queued', 7],
    ]);
    expect(orders(state, 11)).toEqual([queueOrderLabel(8)]);
    expect(orders(state, 12)).toEqual([queueOrderLabel(9)]);
    for (const n of [60, 61, 62]) {
      expect(orders(state, n)).toHaveLength(1);
      expect(state.get(n)?.has(QUEUED_LABEL)).toBe(true);
      expect(state.get(n)?.has(L)).toBe(true);
    }
    state.get(P)?.delete(IN_PROGRESS_LABEL);
    state.get(P)?.delete(queueOrderLabel(4));
    state.get(P)?.delete(L);
    expect(await queue.list('bugfix')).toEqual([1, 2, 3, 60, 61, 62, 11, 12]);
  });

  it('never leaves two open in-lane issues sharing an order', async () => {
    const { client, state } = createStore([
      parent,
      queued(11, 5),
      { number: 12, labels: [IN_PROGRESS_LABEL, L, queueOrderLabel(6)] },
      queued(13, 7),
      { number: 60, labels: [] },
      { number: 61, labels: [] },
    ]);

    await queueFor(client).enqueueAfter('bugfix', P, [60, 61]);

    const all = [...state].filter(([, set]) => set.has(L)).flatMap(([n]) => orders(state, n));
    expect(all).toHaveLength(6);
    expect(new Set(all).size).toBe(all.length);
  });

  it('skips an already-queued child and keeps its single order label', async () => {
    const { client, state } = createStore([
      parent,
      queued(11, 5),
      queued(60, 12),
      { number: 61, labels: [] },
      { number: 62, labels: [] },
    ]);

    const res = await queueFor(client).enqueueAfter('bugfix', P, [60, 61, 62]);

    expect(res.results[0]).toMatchObject({ issue: 60, outcome: 'already-queued', position: 12 });
    expect(orders(state, 60)).toEqual([queueOrderLabel(12)]);
    expect(res.results.map((r) => r.position)).toEqual([12, 5, 6]);
    expect(orders(state, 11)).toEqual([queueOrderLabel(7)]);
  });

  it('falls back to the tail when the parent has no order label', async () => {
    const { client } = createStore([
      { number: P, labels: [IN_PROGRESS_LABEL, L] },
      queued(11, 5),
      { number: 60, labels: [] },
      { number: 61, labels: [] },
    ]);

    const res = await queueFor(client).enqueueAfter('bugfix', P, [60, 61]);

    expect(res.placement).toBe('tail');
    expect(res.results.map((r) => r.position)).toEqual([6, 7]);
  });

  it('reports a failed child', async () => {
    const { client } = createStore(
      [parent, { number: 60, labels: [] }, { number: 61, labels: [] }, { number: 62, labels: [] }],
      { add: (n) => n === 61 },
    );

    const res = await queueFor(client).enqueueAfter('bugfix', P, [60, 61, 62]);

    expect(res.results.map((r) => r.outcome)).toEqual(['queued', 'failed', 'queued']);
    expect(res.results[1]?.detail).toContain('boom');
  });

  it('reports the shift failure and still queues the children at the tail', async () => {
    const { client, state } = createStore([parent, queued(11, 5), { number: 60, labels: [] }], { remove: true });

    const res = await queueFor(client).enqueueAfter('bugfix', P, [60]);

    expect(res.placement).toBe('tail');
    expect(res.detail).toContain('remove boom');
    expect(res.results[0]?.outcome).toBe('queued');
    expect(state.get(60)?.has(QUEUED_LABEL)).toBe(true);
  });
});
