// packages/cli/src/cli/ship-run-state.ts — RunPorts.recordRunState for shipIssue (#3194); keeps steers appended mid-run (#3401)
import {
  nextIssueRunState,
  readIssueRunState,
  runStateFile,
  writeIssueRunState,
  type IssueRunState,
  type IssueRunStateBase,
  type RunStateUpdate,
} from '@on-par/factory-core/internal';
import { phaseSnapshotFile, writePhaseSnapshot, type FailurePhase } from '@on-par/factory-core';

/** Persists `state/runs/issue-<n>.json` on every update. The previous record lives in the closure, so
 *  `startedAt` and the other fixed fields come from `base` and no stale file from an earlier run leaks in. */
export function runStateRecorder(runsDir: string, base: IssueRunStateBase): (update: RunStateUpdate) => Promise<void> {
  let current: IssueRunState | undefined;
  return async (update) => {
    current = nextIssueRunState(current, base, update, new Date().toISOString());
    const file = runStateFile(runsDir, base.issue);
    const onDisk = await readIssueRunState(file);
    // `factory steer` appends to the file while the run is in flight (#3401); keep those steers.
    if (onDisk?.startedAt === base.startedAt && onDisk.steers !== undefined)
      current = { ...current, steers: onDisk.steers };
    await writeIssueRunState(file, current);
  };
}

/** RunPorts.recordPhase: stamps the phase snapshot with the current time as both update and activity. */
export function phaseRecorder(runsDir: string, issue: number): (phase: FailurePhase) => Promise<void> {
  return (phase) => {
    const now = new Date().toISOString();
    return writePhaseSnapshot(phaseSnapshotFile(runsDir, issue), { issue, phase, updatedAt: now, lastActivityAt: now });
  };
}
