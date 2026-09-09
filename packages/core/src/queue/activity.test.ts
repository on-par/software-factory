import { describe, expect, it } from 'vitest';

import type { RunPhaseSnapshot } from '../run/phase-snapshot.js';
import type { QueueEntry } from './index.js';
import { DEFAULT_QUEUE_ACTIVITY_STALE_THRESHOLD_MS, partitionLocalQueueByActivity } from './activity.js';

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
    const result = await partitionLocalQueueByActivity(entries, '/tmp/runs', {
      now: () => NOW,
      readSnapshot: async () => snapshotAt(1, new Date(NOW - 60_000).toISOString()),
    });

    expect(result).toEqual({ active: entries, staleCount: 0 });
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
    const result = await partitionLocalQueueByActivity(entries, '/tmp/runs', {
      now: () => NOW,
      readSnapshot: async (file) => {
        if (file.includes('issue-2')) return snapshotAt(2, new Date(NOW - 60_000).toISOString());
        if (file.includes('issue-3')) return snapshotAt(3, new Date(NOW - 60_000).toISOString());
        return null;
      },
    });

    expect(result.active).toEqual([entry('infra', 2), entry('app', 3)]);
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
