// packages/cli/src/cli/run-lane-rechecks.ts — the lane's pre-claim re-checks and left-open handling, split out of run-lane.ts

import type { EventKind } from '@on-par/factory-core';
import { nextRecheckAt, type AwaitingCiRecord, type LandDeferralDecision } from '@on-par/factory-core/internal';

import type { AwaitingCiLaneOps } from './awaiting-ci-recheck.js';
import type { LandDeferredLaneOps } from './land-deferred-retry.js';
import { LandDeferredError, type AwaitingCiError } from './land-pr.js';
import { shipRuntime } from './ship-runtime.js';

export interface PreClaimRechecks {
  pollReviewRework?: () => Promise<void>;
  recheckAwaitingCi?: (ops: AwaitingCiLaneOps) => Promise<void>;
  retryLandDeferred?: (ops: LandDeferredLaneOps) => Promise<void>;
  awaitingOps: AwaitingCiLaneOps;
  deferredOps: LandDeferredLaneOps;
  warn: (message: string) => void;
}

/** Runs before every remote claim: the review-rework poll (#3563), the awaiting-ci re-check (#3208), then the
 *  land-deferred drain (#3957). Each is fail-closed: a rejection is a warn and never changes lane flow. */
export async function runPreClaimRechecks(rc: PreClaimRechecks): Promise<void> {
  const detail = (err: unknown): string => shipRuntime().errorDetail(err);
  if (rc.pollReviewRework) {
    await rc.pollReviewRework().catch((err) => rc.warn(`review-rework poll failed: ${detail(err)}`));
  }
  if (rc.recheckAwaitingCi) {
    await rc.recheckAwaitingCi(rc.awaitingOps).catch((err) => rc.warn(`awaiting-ci recheck failed: ${detail(err)}`));
  }
  if (rc.retryLandDeferred) {
    await rc.retryLandDeferred(rc.deferredOps).catch((err) => rc.warn(`land-deferred retry failed: ${detail(err)}`));
  }
}

export interface LeftOpenCtx {
  issue: number;
  landBranch: string | undefined;
  now: () => Date;
  emit: (kind: EventKind, issue: number, message: string) => void;
  recordAwaitingCi?: (rec: AwaitingCiRecord) => Promise<void>;
  recordLandDeferred?: (
    err: LandDeferredError,
    issue: number,
    branch: string,
  ) => Promise<LandDeferralDecision & { maxDeferrals: number }>;
}

/** A land that left the PR open without a verdict: awaiting-ci (#3208) records it for the backoff re-check, a
 *  moving-base give-up (#3957) queues a land-only retry. 'unhandled' falls through to the lane's park path. */
export async function handleLeftOpen(
  err: AwaitingCiError | LandDeferredError,
  ctx: LeftOpenCtx,
): Promise<'handled' | 'unhandled'> {
  const { issue, emit } = ctx;
  if (!(err instanceof LandDeferredError)) {
    // #3208: no CI run ever registered. Keep the PR open and record it for the backoff re-check; never a park.
    const firstSeenAt = ctx.now().getTime();
    const rec = { issue, prNumber: err.prNumber, branch: ctx.landBranch ?? '', headSha: err.headSha, firstSeenAt };
    await ctx.recordAwaitingCi?.({ ...rec, attempts: 0, nextRecheckAt: nextRecheckAt(firstSeenAt, 0) }).catch((e) =>
      emit('warn', issue, `could not record awaiting-ci for PR #${err.prNumber}: ${shipRuntime().errorDetail(e)}`),
    );
    emit('awaiting-ci', issue, `PR #${err.prNumber} awaiting CI on ${err.headSha}; re-checking soon`);
    return 'handled';
  }
  if (!ctx.recordLandDeferred) return 'unhandled';
  const decision = await ctx.recordLandDeferred(err, issue, err.branch).catch((e: unknown) => {
    emit('warn', issue, `could not record land-deferred for PR #${err.prNumber}: ${shipRuntime().errorDetail(e)}`);
    return undefined;
  });
  if (decision?.kind !== 'defer') return 'unhandled';
  const { record, maxDeferrals } = decision;
  emit(
    'land-deferred',
    issue,
    `PR #${err.prNumber} deferred (${record.deferrals}/${maxDeferrals}): ${err.message}; land-only retry at ${new Date(record.nextRetryAt).toISOString()}`,
  );
  return 'handled';
}
