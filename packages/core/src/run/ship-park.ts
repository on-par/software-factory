import type { ShipResult } from '../phases/ship.js';
import type { CheckFailureInfo, CiFailureEvidence } from '../types/index.js';

import type { ParkReason } from './outcome.js';

export function shipParkReason(ship: ShipResult): ParkReason {
  if (ship.denied) return 'escalate';
  if (ship.previewCheck && ship.previewCheck.status !== 'pass') return 'fail';
  if (ship.visualProof && !['pass', 'not-required'].includes(ship.visualProof.status)) return 'fail';
  if (ship.ciOutcome === 'infra-failure') return 'ci-infra';
  return ship.ciOutcome === 'failure' ? 'ci-failed' : 'fail';
}

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
