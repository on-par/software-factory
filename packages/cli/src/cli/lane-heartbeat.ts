// src/cli/lane-heartbeat.ts — claim-lease heartbeat around an in-flight issue, split from run-lane.ts

import type { logEvent } from '@on-par/factory-core/internal';

import { shipRuntime } from './ship-runtime.js';

/** How often an in-flight issue's claim lease is refreshed (#1500). Well inside the
 *  15-minute default lease (github-queue.ts's DEFAULT_CLAIM_LEASE_MS) so a normal poll
 *  cadence never lets the lease lapse mid-ship. */
const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;

/** The issue's claim is no longer ours: the queue said it is gone ('released'), or renewals
 *  kept failing past the last confirmed expiry ('lapsed') (#3146). */
export class ClaimLostError extends Error {
  constructor(
    readonly issue: number,
    readonly kind: 'released' | 'lapsed',
  ) {
    super(`claim on #${issue} lost (${kind})`);
    this.name = 'ClaimLostError';
  }
}

/** Lease health of one in-flight issue. `signal` aborts (with the ClaimLostError) once the claim is lost. */
export interface ClaimLease {
  readonly signal: AbortSignal;
  readonly lost: ClaimLostError | undefined;
  renewed(result: unknown): void;
  renewFailed(err: unknown): void;
}

/** Tracks one issue's lease. Only a strict `false` heartbeat result means lost; a thrown renewal is
 *  counted and logged, and the lease is lost once `now()` passes the last confirmed expiry. */
export function createClaimLease(
  issue: number,
  opts: { leaseMs: number; now: () => number; onRenewFailed: (failures: number, err: unknown) => void },
): ClaimLease {
  const controller = new AbortController();
  let confirmedExpiry = opts.now() + opts.leaseMs;
  let failures = 0;
  let lost: ClaimLostError | undefined;
  const lose = (kind: 'released' | 'lapsed'): void => {
    if (lost) return;
    lost = new ClaimLostError(issue, kind);
    controller.abort(lost);
  };
  return {
    signal: controller.signal,
    get lost() {
      return lost;
    },
    renewed(result) {
      if (lost) return;
      if (result === false) return lose('released');
      confirmedExpiry = opts.now() + opts.leaseMs;
      failures = 0;
    },
    renewFailed(err) {
      if (lost) return;
      failures++;
      opts.onRenewFailed(failures, err);
      if (opts.now() >= confirmedExpiry) lose('lapsed');
    },
  };
}

/** The `onRenewFailed` for a lane's lease: one `lease_renew_failed` event per failed renewal, with the consecutive count. */
export function laneRenewLogger(
  emit: typeof logEvent,
  eventsFile: string,
  lane: string,
  issue: number,
): (failures: number, err: unknown) => void {
  return (failures, err) =>
    emit(
      eventsFile,
      'lease_renew_failed',
      issue,
      `claim lease renewal for #${issue} failed (${failures} consecutive): ${shipRuntime().errorDetail(err)}`,
      { lane },
    );
}

/** Emits `claim_lost` for a lane that no longer holds `err.issue`'s claim (#3146). The caller must not release,
 *  park or reap: another host owns the issue now, and the worktree is kept. */
export function onClaimLost(
  err: ClaimLostError,
  emit: typeof logEvent,
  eventsFile: string,
  lane: string,
  hostId: string,
  runId: string,
): void {
  const { issue, kind } = err;
  emit(
    eventsFile,
    'claim_lost',
    issue,
    `claim on #${issue} lost (${kind}) for host ${hostId}, run ${runId}; stopped before push/PR/merge; worktree kept, issue not released`,
    { lane, claimLost: { hostId, issue, runId, kind } },
  );
}

/** Runs `work` while periodically calling `heartbeat(issue)` so a long-running ship or
 *  merge wait keeps this claimant's lease fresh. With a `lease`, every tick result feeds it: a single
 *  failed refresh is logged but does not abort, while a lost claim aborts `work`'s signal and
 *  surfaces as ClaimLostError (#3146). Before returning or rethrowing, the
 *  timer is cleared and any in-flight tick is awaited, so no heartbeat write overlaps the
 *  caller's release of the claim (#3423). */
export async function withHeartbeat<T>(
  issue: number,
  heartbeat: ((issue: number) => Promise<unknown>) | undefined,
  work: (signal: AbortSignal) => Promise<T>,
  lease?: ClaimLease,
): Promise<T> {
  if (lease?.lost) throw lease.lost;
  const signal = lease?.signal ?? new AbortController().signal;
  if (!heartbeat) return work(signal);
  let inFlight: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = Promise.resolve()
      .then(() => heartbeat(issue))
      .then(
        (result) => lease?.renewed(result),
        (err) => lease?.renewFailed(err),
      )
      .finally(() => {
        inFlight = undefined;
      });
  }, HEARTBEAT_INTERVAL_MS);
  try {
    return await work(signal);
  } catch (err) {
    if (lease?.lost) throw lease.lost;
    throw err;
  } finally {
    clearInterval(timer);
    await inFlight;
  }
}
