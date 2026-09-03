import type { EventKind } from '../events/kinds.js';

export type ParkReason = Extract<EventKind, 'escalate' | 'timeout' | 'fail' | 'conflict' | 'ci-failed' | 'held'>;

export type BuildRoute = 'codex' | 'claude' | 'opencode';

/** A run's terminal outcome. Only the `parked` variant is produced today (by the CLI's
 *  LaneParkError); `shipped` / `ready` / `escalated` are defined here for later stories
 *  (#4, #5) that re-point the CLI supervisor and the sim onto this union. */
export type RunOutcome =
  | { state: 'shipped'; route: BuildRoute; branch: string; reworkRounds: number; prNumber: number }
  | { state: 'ready'; route: BuildRoute; branch: string; reworkRounds: number; prNumber?: number }
  | {
      state: 'parked';
      reason: ParkReason;
      route?: BuildRoute;
      branch?: string;
      reworkRounds?: number;
      prNumber?: number;
    }
  | { state: 'escalated'; reason: string; route?: BuildRoute; branch?: string; reworkRounds?: number };

/** Core classifies structurally — via a parked RunOutcome on `err.outcome` or a
 *  `parkReason` marker property — rather than `instanceof`, because core cannot import
 *  the CLI's error classes (LaneParkError, LandConflictError, CiFailedError). */
export function parkReasonFor(err: unknown): ParkReason {
  const outcome = (err as { outcome?: RunOutcome } | null | undefined)?.outcome;
  if (outcome && outcome.state === 'parked') return outcome.reason;
  const marker = (err as { parkReason?: ParkReason } | null | undefined)?.parkReason;
  if (marker) return marker;
  if ((err as { reason?: unknown } | null | undefined)?.reason === 'timeout') return 'timeout';
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
