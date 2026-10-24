// packages/cli/src/cli/ship-phase-snapshot.ts — the per-issue phase-snapshot ports shipIssue hands to runIssue (#1325, #3640)

import {
  type EventKind,
  type FailurePhase,
  phaseSnapshotFile,
  summarizeEvent,
  touchLastEvent,
  touchRunActivity,
  workKeyFromIssue,
  writePhaseSnapshot,
} from '@on-par/factory-core';

/** Writes, heartbeats and annotates `state/runs/issue-<n>.phase.json`; the CLI keeps plain issue numbers, the file helpers take a work key. */
export function phaseSnapshotPorts(runsDir: string, issueNum: number) {
  const file = phaseSnapshotFile(runsDir, workKeyFromIssue(issueNum));
  return {
    recordPhase: (phase: FailurePhase) => {
      const now = new Date().toISOString();
      return writePhaseSnapshot(file, { issue: issueNum, phase, updatedAt: now, lastActivityAt: now });
    },
    onActivity: () => touchRunActivity(file, new Date().toISOString()),
    touchLastEvent: (type: EventKind, msg: string) => touchLastEvent(file, summarizeEvent(type, msg)),
  };
}
