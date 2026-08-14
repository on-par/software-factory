// packages/core/src/run/outcome.ts — A run's terminal outcome, as a value.
//
// Single owner of the park-classification concern (mirrors the single-owner
// spirit of ADR-0021): ParkReason, the RunOutcome discriminated union, the
// parkReasonFor/parkEvents classification, and the marker errors the
// classification recognises by instanceof. The CLI re-raises these outcomes
// through its LaneParkError wrapper (#672); the simulator's mirror in
// sim/pipeline.ts is a migration target rather than a maintained duplicate.

import type { EventKind } from '../events/kinds.js';

export type Route = 'codex' | 'claude';

export type ParkReason = Extract<EventKind, 'escalate' | 'timeout' | 'fail' | 'conflict' | 'ci-failed'>;

export type RunOutcome =
  | { state: 'shipped'; route: Route; branch: string; reworkRounds: number; prNumber: number }
  | { state: 'ready'; route: Route; branch: string; reworkRounds: number; prNumber?: number }
  | { state: 'parked'; route?: Route; branch?: string; reworkRounds?: number; reason: ParkReason }
  | { state: 'escalated'; route?: Route; branch?: string; reworkRounds?: number; reason: ParkReason };

export type ParkOutcome = Extract<RunOutcome, { state: 'parked' }> | Extract<RunOutcome, { state: 'escalated' }>;

/** A land/merge attempt hit a rebase conflict that needs a human to resolve. */
export class LandConflictError extends Error {}

/** A confirmed CI failure — a completed check run with a non-passing
 *  conclusion. A confirmed failing check must never be merged. */
export class CiFailedError extends Error {
  constructor(
    message: string,
    readonly prNumber: number,
  ) {
    super(message);
  }
}

/** The CI watch never reached a green verdict — a subclass of CiFailedError so
 *  every existing guard (parkReasonFor → 'ci-failed', worktree cleanup, the
 *  land exit-0 path) treats "we don't know" exactly like "we know it's red". */
export class CiUnverifiedError extends CiFailedError {}

/** The park reason for a thrown error, in precedence order: a carried ParkOutcome
 *  first, then the instanceof markers, then the `reason === 'timeout'` marker,
 *  then a plain `'fail'` default. */
export function parkReasonFor(err: unknown): ParkReason {
  const outcome = (err as { outcome?: RunOutcome } | null)?.outcome;
  if (outcome && (outcome.state === 'parked' || outcome.state === 'escalated')) return outcome.reason;
  if (err instanceof LandConflictError) return 'conflict';
  if (err instanceof CiFailedError) return 'ci-failed';
  if ((err as { reason?: unknown } | null)?.reason === 'timeout') return 'timeout';
  return 'fail';
}

/** Terminal events to emit when a run parks. A timeout park additionally emits
 *  an explicit 'stuck' event so stuckRate observes runs that exceeded their
 *  phase timeout (#428). The other stuck condition — identical checker failures
 *  across consecutive rework rounds — is emitted by the check phase itself. */
export function parkEvents(err: unknown): { type: EventKind; msg: string }[] {
  const reason = parkReasonFor(err);
  const msg = err instanceof Error ? err.message : String(err);
  const events: { type: EventKind; msg: string }[] = [{ type: reason, msg }];
  if (reason === 'timeout') {
    events.push({ type: 'stuck', msg: `run exceeded its phase timeout without progressing — ${msg}` });
  }
  return events;
}
