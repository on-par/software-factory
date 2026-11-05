import type { PreviewCheckResult } from '../checkers/preview-check.js';
import type { CiFailureEvidence } from '../types/index.js';
import type { InfraRerunOutcome } from '../utils/ci-watch.js';

/** Why SHIP left a PR as a draft (#3932): 'ci-pending' = CI had not finished (the sweep may land it); 'requested' = draft mode. */
export type ShipDraftReason = 'ci-pending' | 'requested';

export interface ShipResult {
  ok: boolean;
  prNumber?: number;
  denied?: boolean;
  deniedReason?: string;
  reason?: string;
  ciOutcome?: InfraRerunOutcome;
  /** Bounded evidence for a CI-watch 'failure' (#2814). */
  ciFailure?: CiFailureEvidence;
  /** True when the branch's content had already landed on main (e.g. a retry after a
   *  squash merge) — nothing was pushed and no PR was created (#520). */
  alreadyDelivered?: boolean;
  /** The head SHA watched on a CI rework re-entry (#2816). */
  headSha?: string;
  /** Draft mode (#3449): mark-ready skipped; callers must not merge. */
  draft?: boolean;
  /** CI watch timed out before a verdict (#3569): the PR was left as draft. */
  ciPending?: boolean;
  /** Why an ok result is a draft (#3932); the run-state comment carries it for the CI-pending sweep. */
  draftReason?: ShipDraftReason;
  previewCheck?: PreviewCheckResult;
}

/** The result of asking GitHub whether a PR exists for a branch. `error` is never collapsed
 *  into `absent` — an unanswered lookup makes ship fail closed rather than open a duplicate
 *  PR (#641). */
export type PrLookup =
  { status: 'found'; prNumber: number } | { status: 'absent' } | { status: 'error'; detail: string };
