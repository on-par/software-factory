// packages/cli/src/cli/land-deferred-retry.ts — land-only retries of PRs deferred by a moving base (#3957)

import { parkReasonFor } from '@on-par/factory-core';
import type { EventKind, ParkReason } from '@on-par/factory-core';
import {
  clearLandDeferred,
  decideLandDeferral,
  dueLandDeferrals,
  readLandDeferred,
  upsertLandDeferred,
  type LandDeferredRecord,
} from '@on-par/factory-core/internal';

import { landRuntime } from './land-runtime.js';
import {
  AwaitingCiError,
  AwaitingReviewError,
  CiFailedError,
  LandConflictError,
  LandDeferredError,
  MergeGatedError,
} from './land-pr.js';
import { BaseCiPendingError } from './merge-base-gate.js';

/** The lane's own park path and event sink, handed to the retry so it parks exactly like a lane park. */
export interface LandDeferredLaneOps {
  park(rec: { issue: number; branch: string }, reason: ParkReason, message: string): Promise<void>;
  emit(kind: EventKind, issue: number, message: string): void;
}

export interface LandDeferredRetryDeps extends LandDeferredLaneOps {
  file: string;
  now(): number;
  maxDeferrals: number;
  /** Runs `fn` while holding the host landing slot. */
  withSlot<T>(fn: () => Promise<T>): Promise<T>;
  /** Syncs, waits for CI and merges the PR pinned to the verified head, holding the slot already. */
  land(rec: LandDeferredRecord): Promise<void>;
}

/** Retries one due record under the slot; false when none was due. */
async function retryOne(deps: LandDeferredRetryDeps): Promise<boolean> {
  const { file, now, maxDeferrals, land, park, emit } = deps;
  const rec = dueLandDeferrals(await readLandDeferred(file), now())[0];
  if (!rec) return false;
  emit(
    'land-deferred',
    rec.issue,
    `retrying PR #${rec.prNumber} (deferral ${rec.deferrals}/${maxDeferrals}), land only`,
  );
  try {
    await land(rec);
    await clearLandDeferred(file, rec.issue);
    emit('landed', rec.issue, `PR #${rec.prNumber} landed on a land-only retry`);
    return true;
  } catch (err) {
    if (err instanceof LandDeferredError || err instanceof AwaitingCiError || err instanceof BaseCiPendingError) {
      const decision = decideLandDeferral(
        rec,
        { issue: rec.issue, prNumber: rec.prNumber, branch: rec.branch, message: err.message },
        { now: now(), maxDeferrals },
      );
      if (decision.kind === 'defer') {
        await upsertLandDeferred(file, decision.record);
        emit(
          'land-deferred',
          rec.issue,
          `PR #${rec.prNumber} deferral ${decision.record.deferrals}/${maxDeferrals}; next retry at ${new Date(decision.record.nextRetryAt).toISOString()}`,
        );
        return true;
      }
      await park(rec, 'ci-failed', decision.message);
    } else if (err instanceof CiFailedError) {
      await park(rec, err.parkReason, err.message);
    } else if (err instanceof LandConflictError) {
      await park(rec, 'conflict', err.message);
    } else if (err instanceof AwaitingReviewError || err instanceof MergeGatedError) {
      emit(err instanceof AwaitingReviewError ? 'awaiting-review' : 'merge-gated', rec.issue, err.message);
    } else {
      await park(rec, parkReasonFor(err), landRuntime().errorDetail(err));
    }
    await clearLandDeferred(file, rec.issue);
    return true;
  }
}

/** Drains every due land-deferred record, oldest deferral first, one record per landing-slot hold. A failing
 *  pass (slot timeout, park failure) is emitted as a warn and ends the drain; it never changes lane flow. */
export async function retryDueLandDeferred(deps: LandDeferredRetryDeps): Promise<void> {
  for (;;) {
    try {
      if (!(await deps.withSlot(() => retryOne(deps)))) return;
    } catch (err) {
      deps.emit('warn', 0, `land-deferred retry failed: ${landRuntime().errorDetail(err)}`);
      return;
    }
  }
}
