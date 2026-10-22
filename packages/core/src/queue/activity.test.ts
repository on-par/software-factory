import { describe, expect, it } from 'vitest';

import type { RunPhaseSnapshot } from '../run/phase-snapshot.js';
import type { QueueEntry } from './index.js';
import type { QueueIssue } from './github-queue.js';
import {
  DEFAULT_QUEUE_ACTIVITY_STALE_THRESHOLD_MS,
  partitionGithubClaimsByActivity,
  partitionLocalQueueByActivity,
} from './activity.js';

const NOW = Date.parse('2026-09-09T12:00:00.000Z');

function entry(lane: string, issue: number): QueueEntry {
  return { lane, issue, lineNo: issue };
}

function snapshotAt(issue: number, lastActivityAt: string): RunPhaseSnapshot {
  return { issue, phase: 'build', updatedAt: lastActivityAt, lastActivityAt };
}

describe('partitionLocalQueueByActivity', () => {
  it('treats a snapshot within the freshness window as active', async () => {
    const entries = [entry('app', 1)];
    const lastActivityAt = new Date(NOW - 60_000).toISOString();
    const result = await partitionLocalQueueByActivity(entries, '/tmp/runs', {
      now: () => NOW,
      readSnapshot: async () => snapshotAt(1, lastActivityAt),
    });

    expect(result).toEqual({
      active: [{ ...entries[0], phase: 'build', lastActivityAt }],
      staleCount: 0,
    });
  });

  it('treats a snapshot older than the threshold as stale', async () => {
    const entries = [entry('app', 1)];
    const result = await partitionLocalQueueByActivity(entries, '/tmp/runs', {
      now: () => NOW,
      readSnapshot: async () =>
        snapshotAt(1, new Date(NOW - (DEFAULT_QUEUE_ACTIVITY_STALE_THRESHOLD_MS + 1)).toISOString()),
    });

    expect(result).toEqual({ active: [], staleCount: 1 });
  });

  it('treats a missing snapshot (never run) as stale', async () => {
    const entries = [entry('app', 1)];
    const result = await partitionLocalQueueByActivity(entries, '/tmp/runs', {
      now: () => NOW,
      readSnapshot: async () => null,
    });

    expect(result).toEqual({ active: [], staleCount: 1 });
  });

  it('preserves original queue order among active entries and counts the rest as stale', async () => {
    const entries = [entry('app', 1), entry('infra', 2), entry('app', 3)];
    const lastActivityAt = new Date(NOW - 60_000).toISOString();
    const result = await partitionLocalQueueByActivity(entries, '/tmp/runs', {
      now: () => NOW,
      readSnapshot: async (file) => {
        if (file.includes('issue-2')) return snapshotAt(2, lastActivityAt);
        if (file.includes('issue-3')) return snapshotAt(3, lastActivityAt);
        return null;
      },
    });

    expect(result.active).toEqual([
      { ...entry('infra', 2), phase: 'build', lastActivityAt },
      { ...entry('app', 3), phase: 'build', lastActivityAt },
    ]);
    expect(result.staleCount).toBe(1);
  });

  it('respects a custom staleThresholdMs', async () => {
    const entries = [entry('app', 1)];
    const result = await partitionLocalQueueByActivity(entries, '/tmp/runs', {
      now: () => NOW,
      staleThresholdMs: 30_000,
      readSnapshot: async () => snapshotAt(1, new Date(NOW - 60_000).toISOString()),
    });

    expect(result).toEqual({ active: [], staleCount: 1 });
  });

  it('returns no active entries and zero stale count for an empty queue', async () => {
    const result = await partitionLocalQueueByActivity([], '/tmp/runs', { readSnapshot: async () => null });
    expect(result).toEqual({ active: [], staleCount: 0 });
  });
});

describe('partitionGithubClaimsByActivity (#3344)', () => {
  const fresh = new Date(NOW - 60_000).toISOString();
  const expiresIn = (sec: number) => `factory:claim-expires:${Math.floor(NOW / 1000) + sec}`;
  const gh = (number: number, labels: string[]): QueueIssue => ({
    number,
    labels: ['factory:in-progress', 'factory:claimed-by:host-1', ...labels],
  });
  const run = (issues: QueueIssue[], lastActivityAt: string | null = fresh) =>
    partitionGithubClaimsByActivity(issues, '/tmp/runs', {
      now: () => NOW,
      readSnapshot: async (file) => {
        if (lastActivityAt === null) return null;
        const issue = Number(/issue-(\d+)/.exec(file)?.[1]);
        return snapshotAt(issue, lastActivityAt);
      },
    });

  it('lists a live claim with a fresh snapshot, taking the lane from the first sorted lane label', async () => {
    const result = await run([gh(5, [expiresIn(600), 'factory:lane:zeta', 'factory:lane:alpha'])]);
    expect(result).toEqual({
      active: [{ lane: 'alpha', issue: 5, phase: 'build', lastActivityAt: fresh }],
      staleCount: 0,
    });
  });

  it('uses "-" when there is no lane label', async () => {
    const result = await run([gh(5, [expiresIn(600)])]);
    expect(result.active[0]?.lane).toBe('-');
  });

  it('counts a stale snapshot as stale', async () => {
    const old = new Date(NOW - DEFAULT_QUEUE_ACTIVITY_STALE_THRESHOLD_MS - 1).toISOString();
    expect(await run([gh(5, [expiresIn(600)])], old)).toEqual({ active: [], staleCount: 1 });
  });

  it('counts a missing snapshot as stale', async () => {
    expect(await run([gh(5, [expiresIn(600)])], null)).toEqual({ active: [], staleCount: 1 });
  });

  it('counts an expired claim as stale', async () => {
    expect(await run([gh(5, [expiresIn(-60)])])).toEqual({ active: [], staleCount: 1 });
  });

  it('counts an issue with no claimed-by label as stale', async () => {
    const issue: QueueIssue = { number: 5, labels: ['factory:in-progress', expiresIn(600)] };
    expect(await run([issue])).toEqual({ active: [], staleCount: 1 });
  });

  it('treats a missing claim-expires label with a fresh snapshot as active', async () => {
    const result = await run([gh(5, ['factory:lane:app'])]);
    expect(result.active).toHaveLength(1);
  });

  it('keeps input order', async () => {
    const result = await run([gh(9, []), gh(3, []), gh(7, [])]);
    expect(result.active.map((c) => c.issue)).toEqual([9, 3, 7]);
  });
});
