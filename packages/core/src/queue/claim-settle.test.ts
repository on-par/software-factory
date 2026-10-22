// packages/core/src/queue/claim-settle.test.ts — claim settle delay and injectable sleep (#3239).

import { describe, expect, it, vi } from 'vitest';

import { loadFactoryConfig, type FactoryConfig } from '../config/index.js';
import { fakeIssueComments } from './fake-issue-comments.js';
import { createClaimSettler, DEFAULT_CLAIM_SETTLE_MS, resolveQueueClaimSettleMs } from './claim-settle.js';
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
  return { client };
}

describe('claim settle delay (#3239)', () => {
  it('claimSettleMs defaults to 3000', () => {
    const { client } = createFakeStore([]);
    expect(DEFAULT_CLAIM_SETTLE_MS).toBe(3000);
    expect(createGithubQueue({ client, owner: 'o', repo: 'r', claimantId: 'aaa-1' }).claimSettleMs).toBe(3000);
  });

  it('settle() awaits the injected sleep with claimSettleMs', async () => {
    const { client } = createFakeStore([]);
    const sleep = vi.fn(async () => {});
    const queue = createGithubQueue({ client, owner: 'o', repo: 'r', claimantId: 'aaa-1', claimSettleMs: 500, sleep });
    await queue.settle();
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(500);
  });

  it('claimNext does not sleep', async () => {
    const { client } = createFakeStore([{ number: 1, labels: [QUEUED_LABEL, laneLabel('app'), queueOrderLabel(1)] }]);
    const sleep = vi.fn(async () => {});
    const queue = createGithubQueue({ client, owner: 'o', repo: 'r', claimantId: 'aaa-1', sleep });
    await queue.claimNext('app');
    expect(sleep).not.toHaveBeenCalled();
  });

  it('the default sleep is a setTimeout of claimSettleMs', async () => {
    vi.useFakeTimers();
    try {
      const settler = createClaimSettler({ claimSettleMs: 250 });
      let resolved = false;
      const pending = settler.settle().then(() => {
        resolved = true;
      });
      await vi.advanceTimersByTimeAsync(249);
      expect(resolved).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(resolved).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('resolveQueueClaimSettleMs (#3239)', () => {
  it('reads queue.claim_settle_ms from the config', () => {
    expect(resolveQueueClaimSettleMs({ ...loadFactoryConfig(), queue: { claim_settle_ms: 0 } })).toBe(0);
  });

  it('falls back to 3000 for a config with no queue section', () => {
    const partial: Partial<FactoryConfig> = { ...loadFactoryConfig() };
    delete partial.queue;
    expect(resolveQueueClaimSettleMs(partial as FactoryConfig)).toBe(3000);
  });
});
