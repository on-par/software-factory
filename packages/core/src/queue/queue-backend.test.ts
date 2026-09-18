// packages/core/src/queue/queue-backend.test.ts — QueueBackend seam adapted from the GitHub-labels queue (#1499).

import { describe, expect, it } from 'vitest';

import {
  claimedByLabel,
  claimExpiresLabel,
  IN_PROGRESS_LABEL,
  laneLabel,
  QUEUED_LABEL,
  queueOrderLabel,
  type QueueGitHubClient,
  type QueueIssue,
} from './github-queue.js';
import { createGithubQueueBackend, type QueueBackend } from './queue-backend.js';

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

describe('createGithubQueueBackend', () => {
  it('returns an object satisfying QueueBackend, with all four members callable', () => {
    const { client } = createFakeStore([]);
    const backend: QueueBackend = createGithubQueueBackend({ client, owner: 'o', repo: 'r', claimantId: 'aaa-1' });

    expect(typeof backend.claimNext).toBe('function');
    expect(typeof backend.release).toBe('function');
    expect(typeof backend.list).toBe('function');
    expect(typeof backend.reap).toBe('function');
  });

  it('claimNext delegates unchanged: claims the lower-order candidate and flips its labels', async () => {
    const { client, state } = createFakeStore([
      { number: 1055, labels: [QUEUED_LABEL, laneLabel('build'), queueOrderLabel(1)] },
      { number: 993, labels: [QUEUED_LABEL, laneLabel('build'), queueOrderLabel(2)] },
    ]);
    const backend = createGithubQueueBackend({ client, owner: 'o', repo: 'r', claimantId: 'aaa-1' });

    const claim = await backend.claimNext('build');

    expect(claim).toEqual({ issue: 1055, decision: { kind: 'build' } });
    expect(state.get(1055)!.has(QUEUED_LABEL)).toBe(false);
    expect(state.get(1055)!.has(IN_PROGRESS_LABEL)).toBe(true);
    expect(state.get(1055)!.has(claimedByLabel('aaa-1'))).toBe(true);
  });

  it('release delegates unchanged: returns a claimed issue to factory:queued', async () => {
    const label = claimedByLabel('aaa-1');
    const { client, state } = createFakeStore([
      { number: 1, labels: [IN_PROGRESS_LABEL, label, laneLabel('build'), queueOrderLabel(1)] },
    ]);
    const backend = createGithubQueueBackend({ client, owner: 'o', repo: 'r', claimantId: 'aaa-1' });

    await backend.release(1);

    expect(state.get(1)!.has(QUEUED_LABEL)).toBe(true);
    expect(state.get(1)!.has(IN_PROGRESS_LABEL)).toBe(false);
    expect(state.get(1)!.has(label)).toBe(false);
  });

  it('list(lane) matches createGithubQueue(...).list(lane) for the same seeded state', async () => {
    const { client } = createFakeStore([
      { number: 1055, labels: [QUEUED_LABEL, laneLabel('build'), queueOrderLabel(1)] },
      { number: 993, labels: [QUEUED_LABEL, laneLabel('build'), queueOrderLabel(2)] },
      { number: 3, labels: [QUEUED_LABEL, laneLabel('other'), queueOrderLabel(1)] },
    ]);
    const backend = createGithubQueueBackend({ client, owner: 'o', repo: 'r', claimantId: 'aaa-1' });

    expect(await backend.list('build')).toEqual([1055, 993]);
  });

  it('list() with no lane returns every lane concatenated, lane-sorted', async () => {
    const { client } = createFakeStore([
      { number: 10, labels: [QUEUED_LABEL, laneLabel('build'), queueOrderLabel(1)] },
      { number: 20, labels: [QUEUED_LABEL, laneLabel('build'), queueOrderLabel(2)] },
      { number: 30, labels: [QUEUED_LABEL, laneLabel('docs'), queueOrderLabel(1)] },
    ]);
    const backend = createGithubQueueBackend({ client, owner: 'o', repo: 'r', claimantId: 'aaa-1' });

    expect(await backend.list()).toEqual([10, 20, 30]);
  });

  it('reap() delegates unchanged: releases an expired-lease claim back to factory:queued', async () => {
    const claimedLabel = claimedByLabel('other-claimant');
    const expiresLabel = claimExpiresLabel(NOW_SECONDS - 60);
    const { state, client } = createFakeStore([{ number: 1, labels: [IN_PROGRESS_LABEL, claimedLabel, expiresLabel] }]);
    const backend = createGithubQueueBackend({ client, owner: 'o', repo: 'r', claimantId: 'aaa-1', now });

    const results = await backend.reap();

    expect(results).toEqual([{ issue: 1, label: expiresLabel, expiresAt: NOW_SECONDS - 60, released: true }]);
    expect(state.get(1)!.has(QUEUED_LABEL)).toBe(true);
  });
});
