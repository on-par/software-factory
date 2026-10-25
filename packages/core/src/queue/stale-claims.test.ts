// packages/core/src/queue/stale-claims.test.ts — Expired-lease claim detection and release (#1500).

import { describe, expect, it, vi } from 'vitest';

import {
  claimedByLabel,
  claimExpiresLabel,
  IN_PROGRESS_LABEL,
  type QueueGitHubClient,
  type QueueIssue,
} from './github-queue.js';
import { findStaleClaims, releaseStaleClaims } from './stale-claims.js';
import { fakeIssueComments } from './fake-issue-comments.js';

const NOW_MS = 1_700_000_000_000;
const NOW_SECONDS = Math.floor(NOW_MS / 1000);
const now = () => NOW_MS;

function createFakeStore(issues: Array<{ number: number; labels: string[] }>, repoLabels: string[] = []) {
  const deletedRepoLabels: string[] = [];
  const repoLabelSet = new Set(repoLabels);
  const state = new Map<number, Set<string>>(issues.map((i) => [i.number, new Set(i.labels)]));

  const client: QueueGitHubClient = {
    async listOpenIssuesWithLabels({ labels }) {
      const result: QueueIssue[] = [];
      for (const [number, labelSet] of state) {
        if (labels.every((l) => labelSet.has(l))) {
          result.push({ number, labels: [...labelSet] });
        }
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
    async listRepoLabels() {
      return [...repoLabelSet];
    },
    async deleteRepoLabel({ name }) {
      deletedRepoLabels.push(name);
      repoLabelSet.delete(name);
    },
    async listAllOpenIssues() {
      return [...state].map(([number, set]) => ({ number, labels: [...set] }));
    },
  };

  return { state, client, deletedRepoLabels, repoLabelSet };
}

describe('findStaleClaims', () => {
  it('returns an issue whose lease has expired', () => {
    const label = claimExpiresLabel(NOW_SECONDS - 60);
    const issues: QueueIssue[] = [{ number: 1, labels: [IN_PROGRESS_LABEL, label] }];
    const stale = findStaleClaims(issues, { now });
    expect(stale).toEqual([{ issue: 1, label, expiresAt: NOW_SECONDS - 60 }]);
  });

  it('skips an issue whose lease has not yet expired', () => {
    const label = claimExpiresLabel(NOW_SECONDS + 60);
    const issues: QueueIssue[] = [{ number: 1, labels: [IN_PROGRESS_LABEL, label] }];
    const stale = findStaleClaims(issues, { now });
    expect(stale).toEqual([]);
  });

  it('treats an issue at the exact expiry second as stale (the deadline has passed)', () => {
    const label = claimExpiresLabel(NOW_SECONDS);
    const issues: QueueIssue[] = [{ number: 1, labels: [IN_PROGRESS_LABEL, label] }];
    const stale = findStaleClaims(issues, { now });
    expect(stale).toEqual([{ issue: 1, label, expiresAt: NOW_SECONDS }]);
  });

  it('skips an issue carrying factory:in-progress but no lease label', () => {
    const issues: QueueIssue[] = [{ number: 1, labels: [IN_PROGRESS_LABEL] }];
    const stale = findStaleClaims(issues, { now });
    expect(stale).toEqual([]);
  });

  it('skips an issue carrying one expired and one still-live lease label', () => {
    const expired = claimExpiresLabel(NOW_SECONDS - 60);
    const live = claimExpiresLabel(NOW_SECONDS + 60);
    const issues: QueueIssue[] = [{ number: 1, labels: [IN_PROGRESS_LABEL, expired, live] }];
    const stale = findStaleClaims(issues, { now });
    expect(stale).toEqual([]);
  });

  it('is evaluable identically regardless of which host reaps it — no host/pid evidence involved', () => {
    const label = claimExpiresLabel(NOW_SECONDS - 1);
    const issues: QueueIssue[] = [{ number: 1, labels: [IN_PROGRESS_LABEL, label] }];
    expect(findStaleClaims(issues, { now })).toEqual(findStaleClaims(issues, { now }));
  });
});

describe('releaseStaleClaims', () => {
  it('removes factory:in-progress and the lease label, re-adds factory:queued, leaves lane/order labels', async () => {
    const label = claimExpiresLabel(NOW_SECONDS - 60);
    const { state, client } = createFakeStore([
      { number: 1, labels: [IN_PROGRESS_LABEL, label, 'factory:lane:default', 'factory:order:3'] },
    ]);

    const results = await releaseStaleClaims({ client, owner: 'o', repo: 'r', now });

    expect(results).toEqual([{ issue: 1, label, expiresAt: NOW_SECONDS - 60, released: true, outcome: 'released' }]);
    expect([...state.get(1)!].sort()).toEqual(['factory:lane:default', 'factory:order:3', 'factory:queued'].sort());
  });

  it('returns [] and performs no writes when nothing is stale', async () => {
    const { client } = createFakeStore([{ number: 1, labels: [] }]);
    const addLabels = vi.spyOn(client, 'addLabels');
    const removeLabel = vi.spyOn(client, 'removeLabel');

    const results = await releaseStaleClaims({ client, owner: 'o', repo: 'r', now });

    expect(results).toEqual([]);
    expect(addLabels).not.toHaveBeenCalled();
    expect(removeLabel).not.toHaveBeenCalled();
  });

  it('records released: false with the error message when one issue fails, and still releases the other', async () => {
    const label1 = claimExpiresLabel(NOW_SECONDS - 60);
    const label2 = claimExpiresLabel(NOW_SECONDS - 30);
    const { state, client } = createFakeStore([
      { number: 1, labels: [IN_PROGRESS_LABEL, label1] },
      { number: 2, labels: [IN_PROGRESS_LABEL, label2, 'factory:lane:default', 'factory:order:1'] },
    ]);
    const originalRemoveLabel = client.removeLabel.bind(client);
    client.removeLabel = async (input) => {
      if (input.issue_number === 1) throw new Error('boom');
      return originalRemoveLabel(input);
    };

    const results = await releaseStaleClaims({ client, owner: 'o', repo: 'r', now });

    expect(results).toEqual([
      { issue: 1, label: label1, expiresAt: NOW_SECONDS - 60, released: false, outcome: 'failed', detail: 'boom' },
      { issue: 2, label: label2, expiresAt: NOW_SECONDS - 30, released: true, outcome: 'released' },
    ]);
    expect(state.get(2)!.has('factory:queued')).toBe(true);
  });

  it('leaves a parked issue with an expired lease parked and unqueued (#3193)', async () => {
    const { state, client } = createFakeStore([
      {
        number: 1,
        labels: [IN_PROGRESS_LABEL, claimExpiresLabel(NOW_SECONDS - 60), 'factory:parked', 'factory:lane:self-repair'],
      },
    ]);

    const results = await releaseStaleClaims({ client, owner: 'o', repo: 'r', now });

    expect(results[0]?.released).toBe(true);
    expect([...(state.get(1) ?? [])].sort()).toEqual(['factory:lane:self-repair', 'factory:parked']);
  });

  it('removes the stale claimant labels, in-progress and the expired lease and reports released', async () => {
    const label = claimExpiresLabel(NOW_SECONDS - 60);
    const { state, client } = createFakeStore([
      {
        number: 42,
        labels: [IN_PROGRESS_LABEL, claimedByLabel('host-a-1'), label, 'factory:lane:default', 'factory:order:1'],
      },
    ]);

    const results = await releaseStaleClaims({ client, owner: 'o', repo: 'r', now });

    expect(results).toEqual([{ issue: 42, label, expiresAt: NOW_SECONDS - 60, released: true, outcome: 'released' }]);
    expect([...state.get(42)!].sort()).toEqual(['factory:lane:default', 'factory:order:1', 'factory:queued']);
  });

  it('skips and reports renewed when the fresh read shows a heartbeat-renewed lease', async () => {
    const stale = claimExpiresLabel(NOW_SECONDS - 60);
    const renewed = claimExpiresLabel(NOW_SECONDS + 600);
    const { state, client } = createFakeStore([
      { number: 42, labels: [IN_PROGRESS_LABEL, claimedByLabel('host-a-1'), renewed] },
    ]);
    client.listOpenIssuesWithLabels = async () => [
      { number: 42, labels: [IN_PROGRESS_LABEL, claimedByLabel('host-a-1'), stale] },
    ];
    const removeLabel = vi.spyOn(client, 'removeLabel');

    const results = await releaseStaleClaims({ client, owner: 'o', repo: 'r', now });

    expect(results).toEqual([
      { issue: 42, label: stale, expiresAt: NOW_SECONDS - 60, released: false, outcome: 'renewed' },
    ]);
    expect(removeLabel).not.toHaveBeenCalled();
    expect([...state.get(42)!].sort()).toEqual([IN_PROGRESS_LABEL, claimedByLabel('host-a-1'), renewed].sort());
  });
});

describe('releaseStaleClaims orphan lease-label sweep (#1623)', () => {
  it('releaseStaleClaims sweeps 56 orphaned lease labels and keeps the 4 on open issues (#1623)', async () => {
    const expires = Array.from({ length: 50 }, (_, i) => claimExpiresLabel(NOW_SECONDS + 1000 + i));
    const owners = Array.from({ length: 10 }, (_, i) => claimedByLabel(`host-${i}`));
    const { client, deletedRepoLabels, repoLabelSet } = createFakeStore(
      [
        { number: 1, labels: [IN_PROGRESS_LABEL, expires[0]!, owners[0]!] },
        { number: 2, labels: [IN_PROGRESS_LABEL, expires[1]!, owners[1]!] },
      ],
      [...expires, ...owners],
    );
    const onLabelSweep = vi.fn();
    await expect(releaseStaleClaims({ client, owner: 'o', repo: 'r', now, onLabelSweep })).resolves.toEqual([]);
    expect(deletedRepoLabels).toHaveLength(56);
    expect([...repoLabelSet].sort()).toEqual([expires[0], expires[1], owners[0], owners[1]].sort());
    expect(onLabelSweep).toHaveBeenCalledTimes(1);
  });

  it('releaseStaleClaims deletes leftover lease labels when no issue is claimed (#1623)', async () => {
    const leftovers = [
      claimExpiresLabel(NOW_SECONDS - 500),
      claimExpiresLabel(NOW_SECONDS - 400),
      claimedByLabel('h-9'),
    ];
    const { client, repoLabelSet } = createFakeStore([{ number: 3, labels: ['bug'] }], [...leftovers, 'bug']);
    await releaseStaleClaims({ client, owner: 'o', repo: 'r', now });
    expect([...repoLabelSet]).toEqual(['bug']);
  });

  it('releaseStaleClaims still returns releases when the sweep throws', async () => {
    const stale = claimExpiresLabel(NOW_SECONDS - 60);
    const { client } = createFakeStore([{ number: 1, labels: [IN_PROGRESS_LABEL, claimedByLabel('h-1'), stale] }]);
    client.listRepoLabels = async () => {
      throw new Error('rate limited');
    };
    const onLabelSweepError = vi.fn();
    const out = await releaseStaleClaims({ client, owner: 'o', repo: 'r', now, onLabelSweepError });
    expect(out).toHaveLength(1);
    expect(out[0]!.outcome).toBe('released');
    expect(onLabelSweepError).toHaveBeenCalledTimes(1);
  });
});
