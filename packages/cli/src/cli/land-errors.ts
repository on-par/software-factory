// packages/cli/src/cli/land-errors.ts — CI-verdict errors thrown by the PR-level land (#2784, #3957)

import type { ParkReason } from '@on-par/factory-core';

/** Thrown when watchChecks reports a confirmed CI failure — a completed check run with a
 *  non-passing conclusion. A confirmed failing check must never be merged, admin override
 *  or not. See CiUnverifiedError for the no-verdict case. */
export class CiFailedError extends Error {
  readonly parkReason: ParkReason = 'ci-failed';

  constructor(
    message: string,
    readonly prNumber: number,
  ) {
    super(message);
  }
}

/** Thrown when the CI watch never reached a green verdict — a deadline timeout, no check runs ever
 *  registering, or repeated API failures. A subclass of CiFailedError so every existing guard
 *  (parkReasonFor → 'ci-failed', worktree cleanup, cmdLand's exit-0 path) treats "we don't know"
 *  exactly like "we know it's red": never merge. */
export class CiUnverifiedError extends CiFailedError {}

/** Thrown when the one infra rerun (#2365) also failed for infrastructure reasons on the same head SHA (#2366).
 *  A CiFailedError subclass so every guard still leaves the PR open and unmerged, but it parks as
 *  'ci-infra', which the ADR-0155 steward skips. */
export class CiInfraError extends CiFailedError {
  override readonly parkReason: ParkReason = 'ci-infra';
}

/** #3957: land gave up because origin/main kept moving after MAX_LAND_SYNC_ROUNDS syncs. A CiUnverifiedError
 *  subclass so every caller that does not handle it still parks ci-failed as before. */
export class LandDeferredError extends CiUnverifiedError {
  constructor(
    message: string,
    prNumber: number,
    readonly branch: string,
  ) {
    super(message, prNumber);
  }
}
