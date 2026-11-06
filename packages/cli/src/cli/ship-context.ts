// packages/cli/src/cli/ship-context.ts — the caller-supplied context of one ship run (#2788)
import type {
  getFactoryPaths,
  LocalOnlyPolicy,
  RunOutcome,
  WorkRequest,
  WorkRequestSourceKind,
} from '@on-par/factory-core';
import type { CheckResumeRecord, SlicePlanStore } from '@on-par/factory-core/internal';

import type { shipHostBuildSlot } from './host-slot.js';

export interface ShipContext {
  repoRoot: string;
  ghRepo: string;
  /** Resolved factory state paths, supplied by daemon lanes with an external state root. */
  paths?: ReturnType<typeof getFactoryPaths>;
  lane?: string;
  /** Issues still queued behind this one on its lane, for the park payload (#3511). */
  blockedBehind?: number[];
  workRequest?: WorkRequest;
  /** Receives the core RunOutcome before shipIssue maps it to a return/throw — lets
   *  stacked runs and the run lane read the PR number as data (#1747). */
  onOutcome?: (outcome: RunOutcome) => void;
  /** Input source for planPhase to resolve; defaults inside planPhase to this run's GitHub issue. */
  workSource?: { kind: WorkRequestSourceKind; params: unknown };
  /** Local-only policy (#508): run in this caller-provided workspace, no worktree, no publishing, no SHIP phase. */
  localOnly?: LocalOnlyPolicy;
  /** Per-run BUILD/CHECK slot gate shared by every lane of one run (#3049); absent = host cap only. */
  runSlots?: Parameters<typeof shipHostBuildSlot>[3]['slots'];
  /** Benchmark artifact directory (#509) — only set for local-only runs. */
  artifactsDir?: string;
  resumeFrom?: CheckResumeRecord; // Resume at CHECK on a kept worktree (#2564).
  /** Aborts when the lane loses this issue's claim lease (#3146); becomes RunPorts.claimSignal. */
  signal?: AbortSignal;
  rebuild?: { branch: string }; // #3325: a fresh branch off origin/main, built from the frozen spec with no PLAN
  /** Run-state slice-plan store for a stacked brief (#3813); becomes RunPorts.slicePlanStore. */
  slicePlanStore?: SlicePlanStore;
  feedbackRound?: { prNumber: number }; // #3910: a feedback round on this PR (`factory respond` or a claimed review rework)
}
