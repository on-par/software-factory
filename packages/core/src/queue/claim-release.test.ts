// packages/core/src/queue/claim-release.test.ts — release removes only its own claim; releaseStale re-reads before reaping (#3240).

import { describe, expect, it } from 'vitest';

import {
  CLAIM_EXPIRES_LABEL_PREFIX,
  claimedByLabel,
  claimExpiresLabel,
  createGithubQueue,
  IN_PROGRESS_LABEL,
  laneLabel,
  PARKED_LABEL,
  QUEUED_LABEL,
  queueOrderLabel,
  type QueueGitHubClient,
  type QueueIssue,
} from './github-queue.js';
import { fakeIssueComments } from './fake-issue-comments.js';

function createFakeStore(issues: Array<{ number: number; labels: string[] }>) {
  const state = new Map<number, Set<string>>(issues.map((i) => [i.number, new Set(i.labels)]));
  const calls: string[] = [];
  const client: QueueGitHubClient = {
    async listOpenIssuesWithLabels({ labels }) {
      const result: QueueIssue[] = [];
      for (const [number, labelSet] of state) {
        if (labels.every((l) => labelSet.has(l))) result.push({ number, labels: [...labelSet] });
      }
      return result;
    },
    async getIssueLabels({ issue_number }) {
      return [...(state.get(issue_number) ?? new Set<string>())];
    },
    async addLabels({ issue_number, labels }) {
      calls.push('addLabels');
      const set = state.get(issue_number) ?? new Set<string>();
      for (const label of labels) set.add(label);
      state.set(issue_number, set);
    },
    async removeLabel({ issue_number, name }) {
      calls.push('removeLabel');
      state.get(issue_number)?.delete(name);
    },
    ...fakeIssueComments(),
    async ensureLabel() {
      return false;
    },
  };
  return { state, calls, client };
}

describe('release', () => {
  it("release removes only the caller's claimed-by label", async () => {
    const { client, state } = createFakeStore([
      {
        number: 42,
        labels: [
          IN_PROGRESS_LABEL,
          claimedByLabel('host-a-1'),
          claimedByLabel('host-b-2'),
          laneLabel('build'),
          queueOrderLabel(1),
        ],
      },
    ]);
    const queue = createGithubQueue({ client, owner: 'o', repo: 'r', claimantId: 'host-a-1' });

    await queue.release(42);

    const labels = state.get(42) ?? new Set<string>();
    expect(labels.has(claimedByLabel('host-a-1'))).toBe(false);
    expect(labels.has(claimedByLabel('host-b-2'))).toBe(true);
    expect(labels.has(IN_PROGRESS_LABEL)).toBe(true);
    expect(labels.has(QUEUED_LABEL)).toBe(false);
  });

  it("release(issue, 'parked') with another claimant present adds no parked label and removes only its own", async () => {
    const { client, state } = createFakeStore([
      { number: 42, labels: [IN_PROGRESS_LABEL, claimedByLabel('host-a-1'), claimedByLabel('host-b-2')] },
    ]);
    const queue = createGithubQueue({ client, owner: 'o', repo: 'r', claimantId: 'host-a-1' });

    await queue.release(42, 'parked');

    expect([...(state.get(42) ?? [])].sort()).toEqual([IN_PROGRESS_LABEL, claimedByLabel('host-b-2')].sort());
  });

  it('release writes nothing when only another claimant holds the issue', async () => {
    const { client, calls } = createFakeStore([
      { number: 42, labels: [IN_PROGRESS_LABEL, claimedByLabel('host-b-2')] },
    ]);
    const queue = createGithubQueue({ client, owner: 'o', repo: 'r', claimantId: 'host-a-1' });

    await queue.release(42);

    expect(calls).toEqual([]);
  });

  it("release(issue, 'parked') by the sole claimant removes claim labels and adds factory:parked", async () => {
    const { client, state } = createFakeStore([
      { number: 42, labels: [IN_PROGRESS_LABEL, claimedByLabel('host-a-1'), claimExpiresLabel(2_000_000_000)] },
    ]);
    const queue = createGithubQueue({ client, owner: 'o', repo: 'r', claimantId: 'host-a-1' });

    await queue.release(42, 'parked');

    expect([...(state.get(42) ?? [])]).toEqual([PARKED_LABEL]);
  });
});

describe('releaseStale', () => {
  const NOW_MS = 1_700_000_000_000;
  const nowSec = Math.floor(NOW_MS / 1000);
  const mk = (labels: string[]) => {
    const store = createFakeStore([{ number: 42, labels }]);
    const queue = createGithubQueue({
      client: store.client,
      owner: 'o',
      repo: 'r',
      claimantId: 'host-a-1',
      now: () => NOW_MS,
    });
    return { ...store, queue };
  };

  it("returns 'renewed' and writes nothing when the fresh lease is in the future", async () => {
    const labels = [IN_PROGRESS_LABEL, claimedByLabel('host-b-2'), claimExpiresLabel(nowSec + 60)];
    const { queue, state } = mk(labels);

    expect(await queue.releaseStale(42, [claimedByLabel('host-b-2')])).toBe('renewed');
    expect([...(state.get(42) ?? [])].sort()).toEqual([...labels].sort());
  });

  it("returns 'renewed' for a malformed lease, no lease, and an unclaimed issue", async () => {
    for (const labels of [
      [IN_PROGRESS_LABEL, `${CLAIM_EXPIRES_LABEL_PREFIX}garbage`],
      [IN_PROGRESS_LABEL, claimedByLabel('host-b-2')],
      [QUEUED_LABEL],
    ]) {
      const { queue, state } = mk(labels);
      expect(await queue.releaseStale(42, [claimedByLabel('host-b-2')])).toBe('renewed');
      expect([...(state.get(42) ?? [])].sort()).toEqual([...labels].sort());
    }
  });

  it('removes the stale claim state, re-queues, and leaves a claimed-by label not in staleLabels', async () => {
    const { queue, state } = mk([
      IN_PROGRESS_LABEL,
      claimedByLabel('host-b-2'),
      claimedByLabel('host-c-3'),
      claimExpiresLabel(nowSec - 60),
      laneLabel('build'),
      queueOrderLabel(1),
    ]);

    expect(await queue.releaseStale(42, [claimedByLabel('host-b-2')])).toBe('released');
    expect([...(state.get(42) ?? [])].sort()).toEqual(
      [claimedByLabel('host-c-3'), laneLabel('build'), QUEUED_LABEL, queueOrderLabel(1)].sort(),
    );
  });
});
