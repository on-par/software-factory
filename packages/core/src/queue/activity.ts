// packages/core/src/queue/activity.ts — Distinguishes genuinely active local-queue
// entries from stale ones for `factory status` (#1342). Staleness is judged per-issue
// from RunPhaseSnapshot.lastActivityAt (../run/phase-snapshot.ts, #1336), not from the
// queue file's own mtime: that mtime is shared across every entry and gets touched by
// unrelated decomposition rewrites (rewriteQueueForDecomposition, ./index.ts), so it
// can't tell "this issue is actively running" from "some other entry changed". This
// mirrors the identical stale-heartbeat pattern in ../daemon/engine-supervisor.ts. Read-
// only: never rewrites the queue file (see ADR-0086).

import { phaseSnapshotFile, readPhaseSnapshot, type RunPhaseSnapshot } from '../run/phase-snapshot.js';
import type { QueueEntry } from './index.js';

/** No heartbeat within this window => the entry is presented as stale, not active
 *  (same value as DEFAULT_STALE_THRESHOLD_MS in ../daemon/engine-supervisor.ts). */
export const DEFAULT_QUEUE_ACTIVITY_STALE_THRESHOLD_MS = 15 * 60_000;

/** An active queue entry paired with the per-issue snapshot evidence that made it
 *  count as active, so callers (factory status, #1343) can render phase/age without
 *  re-reading the snapshot file themselves. */
export interface ActiveQueueClaim extends QueueEntry {
  phase: RunPhaseSnapshot['phase'];
  lastActivityAt: string;
}

export interface QueueActivityPartition {
  /** Entries with a fresh per-issue heartbeat, in original queue order. */
  active: ActiveQueueClaim[];
  /** Count of entries with no snapshot, or a snapshot older than the threshold. */
  staleCount: number;
}

/** Partitions local queue-file entries into "active" (fresh per-issue heartbeat) vs
 *  stale, for factory status's `== Active ==` section. An entry with no phase snapshot
 *  yet (never run) counts as stale — it has no evidence of activity to show as "active". */
export async function partitionLocalQueueByActivity(
  entries: readonly QueueEntry[],
  runsDir: string,
  opts: {
    now?: () => number;
    staleThresholdMs?: number;
    readSnapshot?: (file: string) => Promise<RunPhaseSnapshot | null>;
  } = {},
): Promise<QueueActivityPartition> {
  const now = opts.now ?? Date.now;
  const staleThresholdMs = opts.staleThresholdMs ?? DEFAULT_QUEUE_ACTIVITY_STALE_THRESHOLD_MS;
  const readSnapshot = opts.readSnapshot ?? readPhaseSnapshot;

  const snapshots = await Promise.all(
    entries.map(async (entry) => {
      const snapshot = await readSnapshot(phaseSnapshotFile(runsDir, entry.issue));
      if (!snapshot) return null;
      const age = now() - Date.parse(snapshot.lastActivityAt);
      return Number.isFinite(age) && age <= staleThresholdMs ? snapshot : null;
    }),
  );

  const active: ActiveQueueClaim[] = [];
  let staleCount = 0;
  entries.forEach((entry, i) => {
    const snapshot = snapshots[i];
    if (snapshot) active.push({ ...entry, phase: snapshot.phase, lastActivityAt: snapshot.lastActivityAt });
    else staleCount += 1;
  });

  return { active, staleCount };
}
