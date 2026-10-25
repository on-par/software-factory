import { phaseSnapshotFile, type RunPhaseSnapshot, workKeyFromIssue } from '@on-par/factory-core';

/** `lastActivityAt` of one lane's phase snapshot; undefined when it is missing or unreadable. */
export async function readLaneHeartbeat(
  runsDir: string,
  issue: string,
  readSnapshot: (file: string) => Promise<RunPhaseSnapshot | null>,
): Promise<string | undefined> {
  try {
    return (await readSnapshot(phaseSnapshotFile(runsDir, workKeyFromIssue(Number(issue)))))?.lastActivityAt;
  } catch {
    return undefined;
  }
}
