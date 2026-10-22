// packages/core/src/queue/github-queue-claim-fault.test.ts — a claimNext that fails halfway never leaves a claimed issue without a lease (#3434).

import { describe, expect, it } from 'vitest';

import {
  CLAIM_EXPIRES_LABEL_PREFIX,
  CLAIMED_BY_LABEL_PREFIX,
  claimedByLabel,
  claimExpiresLabel,
  createGithubQueue,
  IN_PROGRESS_LABEL,
  laneLabel,
  QUEUED_LABEL,
  queueOrderLabel,
  type QueueGitHubClient,
  type QueueIssue,
} from './github-queue.js';
import { releaseStaleClaims } from './stale-claims.js';
import { fakeIssueComments } from './fake-issue-comments.js';

const NOW = 1_700_000_000_000;

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
    ...fakeIssueComments(),
    async ensureLabel() {
      return false;
    },
  };
  return { state, client };
}

const isExpiry = (name: string) => name.startsWith(CLAIM_EXPIRES_LABEL_PREFIX);
const isClaim = (name: string) => name.startsWith(CLAIMED_BY_LABEL_PREFIX);

function assertLeaseInvariant(labels: Set<string>) {
  if (labels.has(IN_PROGRESS_LABEL) && [...labels].some(isClaim)) expect([...labels].some(isExpiry)).toBe(true);
}

const queuedIssue = () =>
  createFakeStore([{ number: 1, labels: [QUEUED_LABEL, laneLabel('build'), queueOrderLabel(1)] }]);

const faults: Array<[string, (client: QueueGitHubClient) => QueueGitHubClient]> = [
  [
    'the lease addLabels throws',
    (client) => ({
      ...client,
      async addLabels(input) {
        if (input.labels.some(isExpiry)) throw new Error('boom');
        return client.addLabels(input);
      },
    }),
  ],
  [
    'minting the lease label throws',
    (client) => ({
      ...client,
      async ensureLabel(input) {
        if (isExpiry(input.name)) throw new Error('boom');
        return client.ensureLabel(input);
      },
    }),
  ],
];

describe('claimNext fault injection', () => {
  it.each(faults)('rethrows and leaves the issue queued and claimable when %s', async (_name, inject) => {
    const store = queuedIssue();
    const queue = createGithubQueue({ client: inject(store.client), owner: 'o', repo: 'r', claimantId: 'aaa-1' });

    await expect(queue.claimNext('build')).rejects.toThrow('boom');

    const labels = store.state.get(1) ?? new Set<string>();
    expect(labels.has(QUEUED_LABEL)).toBe(true);
    expect(labels.has(IN_PROGRESS_LABEL)).toBe(false);
    expect([...labels].some((l) => isClaim(l) || isExpiry(l))).toBe(false);

    const second = createGithubQueue({ client: store.client, owner: 'o', repo: 'r', claimantId: 'bbb-1' });
    expect((await second.claimNext('build'))?.issue).toBe(1);
  });

  it.each(faults)(
    'an issue left by a failed lease write is claimable or reaped after expiry (%s)',
    async (_n, inject) => {
      const store = queuedIssue();
      const queue = createGithubQueue({
        client: inject(store.client),
        owner: 'o',
        repo: 'r',
        claimantId: 'aaa-1',
        now: () => NOW,
      });
      await expect(queue.claimNext('build')).rejects.toThrow('boom');
      assertLeaseInvariant(store.state.get(1) ?? new Set<string>());

      await releaseStaleClaims({ client: store.client, owner: 'o', repo: 'r', now: () => NOW + 86_400_000 });

      const labels = store.state.get(1) ?? new Set<string>();
      expect(labels.has(QUEUED_LABEL)).toBe(true);
      expect(labels.has(IN_PROGRESS_LABEL)).toBe(false);
    },
  );

  it.each([
    ['a differently named lease', 1_700_000_900, false],
    ['a same-named lease', 1_700_000_000 + Math.floor(30 * 60), true],
  ])(
    'a CAS loser removes its own lease only when the winner holds a different one (%s)',
    async (_n, winnerSecs, same) => {
      const leaseMs = 30 * 60 * 1000;
      const loserLease = claimExpiresLabel(Math.floor((NOW + leaseMs) / 1000));
      const winnerLease = claimExpiresLabel(winnerSecs);
      expect(winnerLease === loserLease).toBe(same);
      const store = queuedIssue();
      let reads = 0;
      const client: QueueGitHubClient = {
        ...store.client,
        async getIssueLabels(input) {
          reads += 1;
          if (reads === 2) {
            const labels = store.state.get(1)!;
            for (const l of [IN_PROGRESS_LABEL, claimedByLabel('aaa-0'), winnerLease]) labels.add(l);
          }
          return store.client.getIssueLabels(input);
        },
      };
      const queue = createGithubQueue({ client, owner: 'o', repo: 'r', claimantId: 'zzz-1', now: () => NOW, leaseMs });

      expect(await queue.claimNext('build')).toBeNull();

      const labels = store.state.get(1) ?? new Set<string>();
      expect(labels.has(claimedByLabel('aaa-0'))).toBe(true);
      expect(labels.has(winnerLease)).toBe(true);
      expect(labels.has(claimedByLabel('zzz-1'))).toBe(false);
      expect(labels.has(loserLease)).toBe(same);
    },
  );
});
