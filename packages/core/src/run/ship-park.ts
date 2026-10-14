// packages/core/src/run/ship-park.ts — maps a failed SHIP result onto its park reason and park-event payload (#2814)

import type { ShipResult } from '../phases/ship.js';
import type { CheckFailureInfo, CiFailureEvidence } from '../types/index.js';

import type { ParkReason } from './outcome.js';

/** Park reason for a failed SHIP: approval denial escalates, CI infra and CI failures keep their own reasons. */
export function shipParkReason(ship: ShipResult): ParkReason {
  if (ship.denied) return 'escalate';
  if (ship.ciOutcome === 'infra-failure') return 'ci-infra';
  return ship.ciOutcome === 'failure' ? 'ci-failed' : 'fail';
}

/** Extra payload for a park event: the CHECK failure signature and/or the SHIP CI evidence, undefined when neither. */
export function parkLogExtra(
  checkFailure: { failureSignature: string; failingChecks: string[] } | undefined,
  ciFailure: CiFailureEvidence | undefined,
): { checkFailure?: CheckFailureInfo; ciFailure?: CiFailureEvidence } | undefined {
  if (!checkFailure && !ciFailure) return undefined;
  return {
    ...(checkFailure
      ? { checkFailure: { signature: checkFailure.failureSignature, failingChecks: checkFailure.failingChecks } }
      : {}),
    ...(ciFailure ? { ciFailure } : {}),
  };
}
