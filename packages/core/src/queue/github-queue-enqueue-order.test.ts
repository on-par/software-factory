// packages/core/src/queue/github-queue-enqueue-order.test.ts — enqueue order selection scans every open in-lane issue (#2987).

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

function createStore(issues: Array<{ number: number; labels: string[] }>) {
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
      const set = state.get(issue_number) ?? new Set<string>();
      for (const label of labels) set.add(label);
      state.set(issue_number, set);
    },
    async removeLabel({ issue_number, name }) {
      state.get(issue_number)?.delete(name);
    },
    ...fakeIssueComments(),
    async ensureLabel() {
      return false;
    },
  };
  return client;
}

const queuedPeers = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    number: i + 1,
    labels: [QUEUED_LABEL, laneLabel('L'), queueOrderLabel(i + 1)],
  }));

const queueFor = (client: QueueGitHubClient) =>
  createGithubQueue({ client, owner: 'o', repo: 'r', claimantId: 'aaa-1' });

describe('enqueue order selection', () => {
  it('does not reuse the order of an in-progress in-lane issue', async () => {
    const client = createStore([
      ...queuedPeers(29),
      { number: 30, labels: [IN_PROGRESS_LABEL, laneLabel('L'), queueOrderLabel(30)] },
    ]);

    const [res] = await queueFor(client).enqueue('L', [100]);

    expect(res?.position).toBe(31);
  });

  it('does not reuse the order of an order-only in-lane issue (no factory:queued)', async () => {
    const client = createStore([{ number: 24, labels: [laneLabel('L'), queueOrderLabel(24)] }]);

    const [res] = await queueFor(client).enqueue('L', [41]);

    expect(res?.position).toBe(25);
  });

  it('skips an order-only position even when queued peers end just below it', async () => {
    const client = createStore([...queuedPeers(23), { number: 24, labels: [laneLabel('L'), queueOrderLabel(24)] }]);

    const [res] = await queueFor(client).enqueue('L', [41]);

    expect(res?.position).not.toBe(24);
    expect(res?.position).toBe(25);
  });

  it('ignores order labels held by issues in other lanes', async () => {
    const client = createStore([
      { number: 7, labels: [QUEUED_LABEL, laneLabel('other'), queueOrderLabel(9)] },
      { number: 8, labels: [laneLabel('other'), queueOrderLabel(12)] },
    ]);

    const [res] = await queueFor(client).enqueue('L', [42]);

    expect(res?.position).toBe(1);
  });

  it('reports the order-only issue holding the slot a queued-only scan would reuse', async () => {
    const client = createStore([...queuedPeers(23), { number: 50, labels: [laneLabel('L'), queueOrderLabel(24)] }]);

    const [res] = await queueFor(client).enqueue('L', [100]);

    expect(res?.position).toBe(25);
    expect(res?.collision).toEqual({ order: 24, heldBy: [50] });
  });

  it('sets no collision when no order-only issue holds the slot', async () => {
    const client = createStore(queuedPeers(3));

    const [res] = await queueFor(client).enqueue('L', [100]);

    expect(res).not.toHaveProperty('collision');
  });

  it('reports a collision only on the batch member whose naive slot is held', async () => {
    const client = createStore([...queuedPeers(23), { number: 50, labels: [laneLabel('L'), queueOrderLabel(24)] }]);

    const [first, second] = await queueFor(client).enqueue('L', [100, 101]);

    expect(first?.position).toBe(25);
    expect(first?.collision).toEqual({ order: 24, heldBy: [50] });
    expect(second?.position).toBe(26);
    expect(second).not.toHaveProperty('collision');
  });

  it('does not report a collision for an order held in another lane', async () => {
    const client = createStore([...queuedPeers(23), { number: 50, labels: [laneLabel('other'), queueOrderLabel(24)] }]);

    const [res] = await queueFor(client).enqueue('L', [100]);

    expect(res?.position).toBe(24);
    expect(res).not.toHaveProperty('collision');
  });
});
