// src/usage/lane-scheduler.ts — Engine lane parks and resumes on acquire denial (#1032).
// Wraps UsageCoordinator.acquire() with per-lane+phase back-off: a denial parks the
// lane until retryAfter and suppresses further acquire() calls until then, so a
// denied engine waits out the reported cooldown instead of hammering acquire().

import type { AcquireResult, GrantRequest } from './grant-ledger.js';

export type LaneAcquire = (request: GrantRequest) => Promise<AcquireResult>;

export interface LaneSchedulerOptions {
  acquire: LaneAcquire;
  now?: () => number;
}

/** Result of evaluating a lane for admission. `parkedUntil` is the epoch-ms
 *  instant before which the lane will not be re-evaluated against acquire. */
export type LaneAdmission = { admitted: true } | { admitted: false; parkedUntil: number };

export interface LaneScheduler {
  evaluate(request: GrantRequest): Promise<LaneAdmission>;
}

function parkKey(request: GrantRequest): string {
  return `${request.repo}#${request.lane}:${request.phase}`;
}

export function createLaneScheduler(options: LaneSchedulerOptions): LaneScheduler {
  const now = options.now ?? Date.now;
  const parkedUntil = new Map<string, number>();

  return {
    async evaluate(request) {
      const key = parkKey(request);
      const until = parkedUntil.get(key);
      const at = now();

      // Parked and the cooldown has not elapsed: suppress the acquire call.
      if (until !== undefined && at < until) {
        return { admitted: false, parkedUntil: until };
      }

      const result = await options.acquire(request);
      if (result.granted) {
        parkedUntil.delete(key);
        return { admitted: true };
      }

      const nextParkedUntil = at + result.retryAfter;
      parkedUntil.set(key, nextParkedUntil);
      return { admitted: false, parkedUntil: nextParkedUntil };
    },
  };
}
