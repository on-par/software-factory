// packages/core/src/queue/activity.ts — Distinguishes genuinely active local-queue
// entries from stale ones for `factory status` (#1342). Staleness is judged per-issue
// from RunPhaseSnapshot.lastActivityAt (../run/phase-snapshot.ts, #1336), not from the
// queue file's own mtime: that mtime is shared across every entry and gets touched by
// unrelated decomposition rewrites (rewriteQueueForDecomposition, ./index.ts), so it
// can't tell "this issue is actively running" from "some other entry changed". This
// mirrors the identical stale-heartbeat pattern in ../daemon/engine-supervisor.ts. Read-
// only: never rewrites the queue file (see ADR-0086).

import { phaseSnapshotFile, readPhaseSnapshot, type RunPhaseSnapshot } from '../run/phase-snapshot.js';
import { workKeyFromIssue } from '../work/work-key.js';
import type { QueueEntry } from './index.js';
import { CLAIMED_BY_LABEL_PREFIX, LANE_LABEL_PREFIX, parseClaimExpiresLabel, type QueueIssue } from './github-queue.js';

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
      const snapshot = await readSnapshot(phaseSnapshotFile(runsDir, workKeyFromIssue(entry.issue)));
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

/** A GitHub-label-queue claim with fresh per-issue activity (#3344). */
export interface GithubActiveClaim {
  lane: string;
  issue: number;
  phase: RunPhaseSnapshot['phase'];
  lastActivityAt: string;
}

/** Partitions `factory:in-progress` GitHub issues into active vs stale for `factory status` (#3344).
 *  `factory run` claims through GitHub labels, so those claims never reach the local queue file.
 *  A claim is live when it carries a `factory:claimed-by:` label and its `factory:claim-expires:`
 *  label (if any) is not past; a live claim is active when its phase snapshot is fresh (#1342).
 *  Read-only: never touches labels or the queue file. */
export async function partitionGithubClaimsByActivity(
  issues: readonly QueueIssue[],
  runsDir: string,
  opts: {
    now?: () => number;
    staleThresholdMs?: number;
    readSnapshot?: (file: string) => Promise<RunPhaseSnapshot | null>;
  } = {},
): Promise<{ active: GithubActiveClaim[]; staleCount: number }> {
  const now = opts.now ?? Date.now;
  const staleThresholdMs = opts.staleThresholdMs ?? DEFAULT_QUEUE_ACTIVITY_STALE_THRESHOLD_MS;
  const readSnapshot = opts.readSnapshot ?? readPhaseSnapshot;

  const isLive = (labels: readonly string[]): boolean => {
    if (!labels.some((l) => l.startsWith(CLAIMED_BY_LABEL_PREFIX))) return false;
    return !labels.some((l) => {
      const expires = parseClaimExpiresLabel(l);
      return expires !== null && expires * 1000 < now();
    });
  };

  const snapshots = await Promise.all(
    issues.map(async (issue) => {
      if (!isLive(issue.labels)) return null;
      const snapshot = await readSnapshot(phaseSnapshotFile(runsDir, workKeyFromIssue(issue.number)));
      if (!snapshot) return null;
      const age = now() - Date.parse(snapshot.lastActivityAt);
      return Number.isFinite(age) && age <= staleThresholdMs ? snapshot : null;
    }),
  );

  const active: GithubActiveClaim[] = [];
  let staleCount = 0;
  issues.forEach((issue, i) => {
    const snapshot = snapshots[i];
    if (!snapshot) {
      staleCount += 1;
      return;
    }
    const lane =
      issue.labels
        .filter((l) => l.startsWith(LANE_LABEL_PREFIX))
        .map((l) => l.slice(LANE_LABEL_PREFIX.length))
        .filter((slug) => slug !== '')
        .sort()[0] ?? '-';
    active.push({ lane, issue: issue.number, phase: snapshot.phase, lastActivityAt: snapshot.lastActivityAt });
  });

  return { active, staleCount };
}
