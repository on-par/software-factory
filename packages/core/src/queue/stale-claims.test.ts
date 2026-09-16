// packages/core/src/queue/stale-claims.test.ts — Expired-lease claim detection and release (#1500).

import { describe, expect, it, vi } from 'vitest';

import { claimExpiresLabel, IN_PROGRESS_LABEL, type QueueGitHubClient, type QueueIssue } from './github-queue.js';
import { findStaleClaims, releaseStaleClaims } from './stale-claims.js';

const NOW_MS = 1_700_000_000_000;
const NOW_SECONDS = Math.floor(NOW_MS / 1000);
const now = () => NOW_MS;

function createFakeStore(issues: Array<{ number: number; labels: string[] }>) {
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
    async ensureLabel() {},
  };

  return { state, client };
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

    expect(results).toEqual([{ issue: 1, label, expiresAt: NOW_SECONDS - 60, released: true }]);
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
      { number: 2, labels: [IN_PROGRESS_LABEL, label2] },
    ]);
    const originalRemoveLabel = client.removeLabel.bind(client);
    client.removeLabel = async (input) => {
      if (input.issue_number === 1) throw new Error('boom');
      return originalRemoveLabel(input);
    };

    const results = await releaseStaleClaims({ client, owner: 'o', repo: 'r', now });

    expect(results).toEqual([
      { issue: 1, label: label1, expiresAt: NOW_SECONDS - 60, released: false, detail: 'boom' },
      { issue: 2, label: label2, expiresAt: NOW_SECONDS - 30, released: true },
    ]);
    expect(state.get(2)!.has('factory:queued')).toBe(true);
  });
});
