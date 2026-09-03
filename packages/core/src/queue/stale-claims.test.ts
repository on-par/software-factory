// packages/core/src/queue/stale-claims.test.ts — Dead-pid claim detection and release (#999).

import { describe, expect, it, vi } from 'vitest';

import {
  claimedByLabel,
  defaultClaimantId,
  IN_PROGRESS_LABEL,
  type QueueGitHubClient,
  type QueueIssue,
} from './github-queue.js';
import { findStaleClaims, localClaimPid, releaseStaleClaims } from './stale-claims.js';

const HOST = 'test-host';

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

describe('localClaimPid', () => {
  const label = claimedByLabel(defaultClaimantId(HOST, 4242));

  it('returns the pid for a label minted by the same host', () => {
    expect(localClaimPid(label, HOST)).toBe(4242);
  });

  it('returns null for a different host', () => {
    expect(localClaimPid(label, 'other-host')).toBeNull();
  });

  it('returns null for a label with no trailing -<digits>', () => {
    expect(localClaimPid('factory:claimed-by:test-host', HOST)).toBeNull();
  });

  it('returns null for a non-claim label', () => {
    expect(localClaimPid('factory:queued', HOST)).toBeNull();
  });
});

describe('findStaleClaims', () => {
  it('returns an issue whose single claim label names a dead local pid', () => {
    const label = claimedByLabel(defaultClaimantId(HOST, 111));
    const issues: QueueIssue[] = [{ number: 1, labels: [IN_PROGRESS_LABEL, label] }];
    const stale = findStaleClaims(issues, { host: HOST, isPidAlive: () => false });
    expect(stale).toEqual([{ issue: 1, label, pid: 111 }]);
  });

  it('skips an issue whose claim pid is alive', () => {
    const label = claimedByLabel(defaultClaimantId(HOST, 111));
    const issues: QueueIssue[] = [{ number: 1, labels: [IN_PROGRESS_LABEL, label] }];
    const stale = findStaleClaims(issues, { host: HOST, isPidAlive: () => true });
    expect(stale).toEqual([]);
  });

  it('skips an issue whose claim label was minted by another host', () => {
    const label = claimedByLabel(defaultClaimantId('other-host', 111));
    const issues: QueueIssue[] = [{ number: 1, labels: [IN_PROGRESS_LABEL, label] }];
    const stale = findStaleClaims(issues, { host: HOST, isPidAlive: () => false });
    expect(stale).toEqual([]);
  });

  it('skips an issue carrying factory:in-progress but no claim label', () => {
    const issues: QueueIssue[] = [{ number: 1, labels: [IN_PROGRESS_LABEL] }];
    const stale = findStaleClaims(issues, { host: HOST, isPidAlive: () => false });
    expect(stale).toEqual([]);
  });

  it('skips an issue carrying one dead-local and one live/foreign claim label', () => {
    const deadLabel = claimedByLabel(defaultClaimantId(HOST, 111));
    const foreignLabel = claimedByLabel(defaultClaimantId('other-host', 222));
    const issues: QueueIssue[] = [{ number: 1, labels: [IN_PROGRESS_LABEL, deadLabel, foreignLabel] }];
    const stale = findStaleClaims(issues, { host: HOST, isPidAlive: () => false });
    expect(stale).toEqual([]);
  });
});

describe('releaseStaleClaims', () => {
  it('removes factory:in-progress and the claim label, re-adds factory:queued, leaves lane/order labels', async () => {
    const label = claimedByLabel(defaultClaimantId(HOST, 111));
    const { state, client } = createFakeStore([
      { number: 1, labels: [IN_PROGRESS_LABEL, label, 'factory:lane:default', 'factory:order:3'] },
    ]);

    const results = await releaseStaleClaims({
      client,
      owner: 'o',
      repo: 'r',
      host: HOST,
      isPidAlive: () => false,
    });

    expect(results).toEqual([{ issue: 1, label, pid: 111, released: true }]);
    expect([...state.get(1)!].sort()).toEqual(['factory:lane:default', 'factory:order:3', 'factory:queued'].sort());
  });

  it('returns [] and performs no writes when nothing is stale', async () => {
    const { client } = createFakeStore([{ number: 1, labels: [] }]);
    const addLabels = vi.spyOn(client, 'addLabels');
    const removeLabel = vi.spyOn(client, 'removeLabel');

    const results = await releaseStaleClaims({ client, owner: 'o', repo: 'r', host: HOST, isPidAlive: () => false });

    expect(results).toEqual([]);
    expect(addLabels).not.toHaveBeenCalled();
    expect(removeLabel).not.toHaveBeenCalled();
  });

  it('records released: false with the error message when one issue fails, and still releases the other', async () => {
    const label1 = claimedByLabel(defaultClaimantId(HOST, 111));
    const label2 = claimedByLabel(defaultClaimantId(HOST, 222));
    const { state, client } = createFakeStore([
      { number: 1, labels: [IN_PROGRESS_LABEL, label1] },
      { number: 2, labels: [IN_PROGRESS_LABEL, label2] },
    ]);
    const originalRemoveLabel = client.removeLabel.bind(client);
    client.removeLabel = async (input) => {
      if (input.issue_number === 1) throw new Error('boom');
      return originalRemoveLabel(input);
    };

    const results = await releaseStaleClaims({ client, owner: 'o', repo: 'r', host: HOST, isPidAlive: () => false });

    expect(results).toEqual([
      { issue: 1, label: label1, pid: 111, released: false, detail: 'boom' },
      { issue: 2, label: label2, pid: 222, released: true },
    ]);
    expect(state.get(2)!.has('factory:queued')).toBe(true);
  });
});
