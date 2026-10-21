// packages/core/src/queue/github-queue-heartbeat.test.ts — heartbeat re-checks the claim before writing a lease (#3422).

import { describe, expect, it } from 'vitest';

import {
  claimedByLabel,
  claimExpiresLabel,
  CLAIM_EXPIRES_LABEL_PREFIX,
  createGithubQueue,
  IN_PROGRESS_LABEL,
  laneLabel,
  PARKED_LABEL,
  QUEUED_LABEL,
  queueOrderLabel,
  type QueueGitHubClient,
  type QueueIssue,
} from './github-queue.js';

function createFakeStore(issues: Array<{ number: number; labels: string[] }>) {
  const state = new Map<number, Set<string>>(issues.map((i) => [i.number, new Set(i.labels)]));
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
      await Promise.resolve();
      const set = state.get(issue_number) ?? new Set<string>();
      for (const label of labels) set.add(label);
      state.set(issue_number, set);
    },
    async removeLabel({ issue_number, name }) {
      state.get(issue_number)?.delete(name);
    },
    async ensureLabel() {
      return false;
    },
  };
  return { state, client };
}

describe('heartbeat interleaved with release', () => {
  function interleaved(client: QueueGitHubClient): {
    client: typeof client;
    arm: (action: () => Promise<void>) => void;
  } {
    let action: (() => Promise<void>) | null = null;
    const wrapped: typeof client = {
      ...client,
      async ensureLabel(params) {
        if (params.name.startsWith(CLAIM_EXPIRES_LABEL_PREFIX) && action) {
          const run = action;
          action = null;
          await run();
        }
        return client.ensureLabel(params);
      },
    };
    return {
      client: wrapped,
      arm: (fn) => {
        action = fn;
      },
    };
  }

  it('heartbeat after release does not re-add claim-expires', async () => {
    const store = createFakeStore([{ number: 42, labels: [QUEUED_LABEL, laneLabel('build'), queueOrderLabel(1)] }]);
    const hook = interleaved(store.client);
    const queue = createGithubQueue({ client: hook.client, owner: 'o', repo: 'r', claimantId: 'aaa-1' });
    await queue.claimNext('build');
    hook.arm(() => queue.release(42, 'parked'));

    const refreshed = await queue.heartbeat(42);

    const labels = store.state.get(42) ?? new Set<string>();
    expect(refreshed).toBe(false);
    expect([...labels].some((l) => l.startsWith(CLAIM_EXPIRES_LABEL_PREFIX))).toBe(false);
    expect(labels.has(IN_PROGRESS_LABEL)).toBe(false);
    expect(labels.has(PARKED_LABEL)).toBe(true);
  });

  it('does not renew when the own claimed-by label is gone on the fresh read', async () => {
    const store = createFakeStore([
      { number: 1, labels: [IN_PROGRESS_LABEL, claimedByLabel('aaa-1'), claimExpiresLabel(1_700_000_000)] },
    ]);
    const hook = interleaved(store.client);
    const queue = createGithubQueue({ client: hook.client, owner: 'o', repo: 'r', claimantId: 'aaa-1' });
    hook.arm(async () => {
      store.state.get(1)?.delete(claimedByLabel('aaa-1'));
    });

    const refreshed = await queue.heartbeat(1);

    const expiry = [...(store.state.get(1) ?? [])].filter((l) => l.startsWith(CLAIM_EXPIRES_LABEL_PREFIX));
    expect(refreshed).toBe(false);
    expect(expiry).toEqual([claimExpiresLabel(1_700_000_000)]);
  });

  it('does not renew when factory:in-progress is gone on the fresh read', async () => {
    const store = createFakeStore([
      { number: 1, labels: [IN_PROGRESS_LABEL, claimedByLabel('aaa-1'), claimExpiresLabel(1_700_000_000)] },
    ]);
    const hook = interleaved(store.client);
    const queue = createGithubQueue({ client: hook.client, owner: 'o', repo: 'r', claimantId: 'aaa-1' });
    hook.arm(async () => {
      store.state.get(1)?.delete(IN_PROGRESS_LABEL);
    });

    const refreshed = await queue.heartbeat(1);

    const expiry = [...(store.state.get(1) ?? [])].filter((l) => l.startsWith(CLAIM_EXPIRES_LABEL_PREFIX));
    expect(refreshed).toBe(false);
    expect(expiry).toEqual([claimExpiresLabel(1_700_000_000)]);
  });
});
