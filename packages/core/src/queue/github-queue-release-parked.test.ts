// packages/core/src/queue/github-queue-release-parked.test.ts — release as parked adds factory:parked before removing claim labels (#3424).

import { describe, expect, it } from 'vitest';

import {
  CLAIMED_BY_LABEL_PREFIX,
  claimedByLabel,
  claimExpiresLabel,
  CLAIM_EXPIRES_LABEL_PREFIX,
  createGithubQueue,
  IN_PROGRESS_LABEL,
  laneLabel,
  PARKED_LABEL,
  QUEUE_ORDER_LABEL_PREFIX,
  queueOrderLabel,
  type QueueGitHubClient,
  type QueueIssue,
} from './github-queue.js';

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
    async ensureLabel() {
      return false;
    },
  };
  return { state, calls, client };
}

describe('release parked', () => {
  const parkedSeed = () => [
    {
      number: 42,
      labels: [
        IN_PROGRESS_LABEL,
        claimedByLabel('aaa-1'),
        claimExpiresLabel(1_700_000_000),
        laneLabel('build'),
        queueOrderLabel(1),
      ],
    },
  ];

  it('release parked leaves factory:parked even when a later label call fails', async () => {
    const { client, state } = createFakeStore(parkedSeed());
    const wrapped: typeof client = {
      ...client,
      async removeLabel() {
        throw new Error('boom');
      },
    };
    const queue = createGithubQueue({ client: wrapped, owner: 'o', repo: 'r', claimantId: 'aaa-1' });

    await expect(queue.release(42, 'parked')).rejects.toThrow('boom');

    expect(state.get(42)?.has(PARKED_LABEL)).toBe(true);
  });

  it('release parked adds factory:parked before any removal and leaves no claim labels', async () => {
    const { client, state, calls } = createFakeStore(parkedSeed());
    const queue = createGithubQueue({ client, owner: 'o', repo: 'r', claimantId: 'aaa-1' });

    await queue.release(42, 'parked');

    expect(calls.indexOf('addLabels')).toBeLessThan(calls.indexOf('removeLabel'));
    const labels = state.get(42) ?? new Set<string>();
    expect(labels.has(PARKED_LABEL)).toBe(true);
    expect(labels.has(laneLabel('build'))).toBe(true);
    expect(labels.has(IN_PROGRESS_LABEL)).toBe(false);
    for (const prefix of [CLAIMED_BY_LABEL_PREFIX, CLAIM_EXPIRES_LABEL_PREFIX, QUEUE_ORDER_LABEL_PREFIX]) {
      expect([...labels].some((l) => l.startsWith(prefix))).toBe(false);
    }
  });

  it('release parked keeps the claim labels when the parked add fails twice', async () => {
    const { client, state } = createFakeStore(parkedSeed());
    const wrapped: typeof client = {
      ...client,
      async addLabels(input) {
        if (input.labels.includes(PARKED_LABEL)) throw new Error('add failed');
        await client.addLabels(input);
      },
    };
    const queue = createGithubQueue({ client: wrapped, owner: 'o', repo: 'r', claimantId: 'aaa-1' });

    await expect(queue.release(42, 'parked')).rejects.toThrow('add failed');

    const labels = state.get(42) ?? new Set<string>();
    expect(labels.has(IN_PROGRESS_LABEL)).toBe(true);
    expect(labels.has(claimedByLabel('aaa-1'))).toBe(true);
    expect(labels.has(claimExpiresLabel(1_700_000_000))).toBe(true);
    expect(labels.has(PARKED_LABEL)).toBe(false);
  });

  it('release parked retries the parked add once', async () => {
    const { client, state } = createFakeStore(parkedSeed());
    let parkedAttempts = 0;
    const wrapped: typeof client = {
      ...client,
      async addLabels(input) {
        if (input.labels.includes(PARKED_LABEL)) {
          parkedAttempts += 1;
          if (parkedAttempts === 1) throw new Error('flaky');
        }
        await client.addLabels(input);
      },
    };
    const queue = createGithubQueue({ client: wrapped, owner: 'o', repo: 'r', claimantId: 'aaa-1' });

    await queue.release(42, 'parked');

    const labels = state.get(42) ?? new Set<string>();
    expect(parkedAttempts).toBe(2);
    expect(labels.has(PARKED_LABEL)).toBe(true);
    expect(labels.has(IN_PROGRESS_LABEL)).toBe(false);
    expect([...labels].some((l) => l.startsWith(CLAIMED_BY_LABEL_PREFIX))).toBe(false);
  });
});
