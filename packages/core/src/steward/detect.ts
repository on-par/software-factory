import { MAX_REWORK_ROUNDS } from '../phases/check.js';
import type { RunOutcome } from '../run/outcome.js';

/** The two ADR-0155 steward triggers. */
export type StuckTrigger = 'check-exhausted' | 'ship-failed';

export interface StuckDetection {
  trigger: StuckTrigger;
  /** The run's CHECK failure signature, when the outcome carries one. */
  failureSignature?: string;
}

/** Classifies a terminal run outcome as stuck per ADR-0155, or null. Pure: no I/O.
 *
 *  `check-exhausted` requires a `failureSignature` because only runIssue's CHECK-fail path
 *  attaches one. Budget parks (`assertBudget`) and non-CI ship failures park `fail` without
 *  one, and ADR-0155 excludes them.
 *  `ship-failed` fires for every parked `ci-failed`, whatever its origin: the land path
 *  (`CiFailedError` / `CiUnverifiedError`) and SHIP's CI watch (`shipParkReason` maps
 *  `ciOutcome: 'failure'` to `ci-failed`, #2814).
 *  `ci-infra` parks are non-triggers: the change did not break CI. */
export function detectStuck(outcome: RunOutcome, reworkBudget: number = MAX_REWORK_ROUNDS): StuckDetection | null {
  if (outcome.state !== 'parked') return null;
  // ci-infra: the one infra rerun also failed for infra (#2366). Like an environment release, the change is not at fault.
  if (outcome.reason === 'ci-infra') return null;
  const signature = outcome.failureSignature ? outcome.failureSignature : undefined;
  if (outcome.reason === 'ci-failed') {
    return signature ? { trigger: 'ship-failed', failureSignature: signature } : { trigger: 'ship-failed' };
  }
  if (outcome.reason === 'fail' && signature && (outcome.reworkRounds ?? 0) >= reworkBudget) {
    return { trigger: 'check-exhausted', failureSignature: signature };
  }
  return null;
}
