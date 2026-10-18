// packages/cli/src/cli/ship-run-state.ts — RunPorts.recordRunState for shipIssue (#3194)
import {
  nextIssueRunState,
  runStateFile,
  writeIssueRunState,
  type IssueRunState,
  type IssueRunStateBase,
  type RunStateUpdate,
} from '@on-par/factory-core/internal';

/** Persists `state/runs/issue-<n>.json` on every update. The previous record lives in the closure, so
 *  `startedAt` and the other fixed fields come from `base` and no stale file from an earlier run leaks in. */
export function runStateRecorder(runsDir: string, base: IssueRunStateBase): (update: RunStateUpdate) => Promise<void> {
  let current: IssueRunState | undefined;
  return async (update) => {
    current = nextIssueRunState(current, base, update, new Date().toISOString());
    await writeIssueRunState(runStateFile(runsDir, base.issue), current);
  };
}
