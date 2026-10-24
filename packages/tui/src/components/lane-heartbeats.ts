// packages/tui/src/components/lane-heartbeats.ts — last-activity stamps for the lanes whose staleness depends on one

import { phaseSnapshotFile, type RunPhaseSnapshot, workKeyFromIssue } from '@on-par/factory-core';

import { isNonTerminalLane, type LaneState } from '../dashboard.js';

/** Reads each non-terminal lane's phase snapshot; a lane whose snapshot cannot be read maps to undefined. */
export async function readLaneHeartbeats(
  lanes: readonly LaneState[],
  runsDir: string,
  readSnapshot: (file: string) => Promise<RunPhaseSnapshot | null>,
): Promise<Record<string, string | undefined>> {
  const next: Record<string, string | undefined> = {};
  // Only non-terminal lanes can go stale, so only they need a heartbeat.
  await Promise.all(
    lanes.filter(isNonTerminalLane).map(async (lane) => {
      try {
        next[lane.issue] = (await readSnapshot(phaseSnapshotFile(runsDir, workKeyFromIssue(Number(lane.issue)))))
          ?.lastActivityAt;
      } catch {
        next[lane.issue] = undefined;
      }
    }),
  );
  return next;
}
