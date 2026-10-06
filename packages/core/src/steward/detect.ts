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
 *  attaches one. Budget parks (`assertBudget`) and ship-phase failures also park `fail` but
 *  carry none, and ADR-0155 excludes budget parks. */
export function detectStuck(outcome: RunOutcome, reworkBudget: number = MAX_REWORK_ROUNDS): StuckDetection | null {
  if (outcome.state !== 'parked') return null;
  const signature = outcome.failureSignature ? outcome.failureSignature : undefined;
  if (outcome.reason === 'ci-failed') {
    return signature ? { trigger: 'ship-failed', failureSignature: signature } : { trigger: 'ship-failed' };
  }
  if (outcome.reason === 'fail' && signature && (outcome.reworkRounds ?? 0) >= reworkBudget) {
    return { trigger: 'check-exhausted', failureSignature: signature };
  }
  return null;
}
