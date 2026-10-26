// packages/cli/src/cli/run-lane.ts — the lane loop, moved out of index.ts (#2800)

import { existsSync, statSync } from 'node:fs';

import { parkReasonFor, workKeyFromIssue } from '@on-par/factory-core';
import type { EventKind, getFactoryPaths, ParkPayload, RunOutcome } from '@on-par/factory-core';
import {
  DEFAULT_CLAIM_LEASE_MS,
  defaultClaimantId,
  logEvent,
  nextRecheckAt,
  PARKED_LABEL,
  parkPayload,
} from '@on-par/factory-core/internal';
import type { AwaitingCiRecord, QueueClaim, QueueReleaseOutcome } from '@on-par/factory-core/internal';

import type { AwaitingCiParkReason } from './awaiting-ci-recheck.js';
import { formatBaseHoldKept, type BaseHoldDecision } from './base-hold.js';
import { holdForDisk } from './run-lane-disk-hold.js';
import { holdForLoad } from './run-lane-load-hold.js';
import { laneParkCommenter } from './lane-park-comment.js';
import {
  pauseLaneForAllProvidersDown,
  pauseLaneForBrokenBase,
  pauseLaneForProviderCap,
  tripLaneBreaker,
  waitForProviderReset,
  waitForProvidersRestored,
} from './lane-pause.js';
import { waitForMerge } from './land.js';
import { AwaitMergeStoppedError, AwaitingCiError, AwaitingReviewError } from './land-pr.js';
import { closeReplacedPullRequest, landWithOneRebuild } from './land-rebuild.js';
import { restoredLoggingBreaker } from './provider-restored-log.js';
import { releaseKeepOnRequeue } from './worktree-keep.js';
import { shipIssue } from './ship.js';
import { ClaimLostError, createClaimLease, laneRenewLogger, onClaimLost, withHeartbeat } from './lane-heartbeat.js';
import { restackUnderHeartbeat } from './run-lane-restack.js';
import { queueDecomposedChildren } from './run-lane-decompose.js';
import type { RunLaneDeps } from './run-lane-deps.js';
import { shipRuntime } from './ship-runtime.js';

export type { RunLaneDeps };

export async function runLane(
  lane: string,
  issues: number[],
  repoRoot: string,
  ghRepo: string,
  paths: ReturnType<typeof getFactoryPaths>,
  deps: RunLaneDeps = {},
): Promise<void> {
  const {
    ship = shipIssue,
    waitMerge = waitForMerge,
    recordStackMerge = async () => {},
    restack = async () => ({ status: 'nothing', reason: 'restack not wired' }),
    pathExists = existsSync,
    emitEvent = logEvent,
    claimNext = async () => null,
    pollReviewRework,
    recordAwaitingCi,
    recheckAwaitingCi,
    releaseIssue = async () => {},
    queueChildren,
    heartbeat,
    leaseMs = DEFAULT_CLAIM_LEASE_MS,
    hostId = defaultClaimantId(),
    reapWorktree = async () => {},
    closeParkedPr = async () => {},
    closeReplacedPr = (replaced) => closeReplacedPullRequest(ghRepo, replaced),
    sweepFinished = async () => {},
    activeIssues = new Set<number>(),
    countRemaining,
    baseHoldGate,
    loadGuard,
    diskGuard,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = () => new Date(),
    laneBreakerThreshold = 0,
    commentIssue = async () => {},
    octokit: getOctokit,
    runId = '-',
    readParkSha = () => Promise.reject(new Error('no park sha reader')),
    providerBreaker = restoredLoggingBreaker(paths.breaker, paths.events, '-', lane, emitEvent),
    configStamp = () => {
      try {
        const st = statSync(paths.config);
        return `${st.mtimeMs}:${st.size}`;
      } catch {
        return '';
      }
    },
  } = deps;
  /** Epoch ms of the earliest provider reset after a provider-cap release; the lane claims nothing before it (#3226). */
  let providerPauseUntil: number | undefined;
  /** Breaker-open providers (and the config stamp) to watch after an all_providers_down park; the lane claims nothing until one closes (#3235). */
  let providersDownWatch: { providers: string[]; configStamp: string } | undefined;
  let streak: { signature: string; firstIssue: number; failingChecks: string[]; count: number } | null = null;
  let merged = 0;
  let awaitingReview = 0;
  let skipped = 0;
  let decomposed = 0;
  let parked = 0;
  const buildClaim = (issue: number): QueueClaim => ({ issue, decision: { kind: 'build' } });
  const pending: QueueClaim[] = issues.map(buildClaim);
  // Issues still pending on this lane after `index`, in queue order (#3511).
  const queuedBehind = (index: number): number[] => pending.slice(index + 1).map((c) => c.issue);
  const seen = new Set(issues);
  // Truthful park-time remaining count (#1222): local pending plus the lane's still-queued remote issues.
  // Fail-closed — a count lookup may never change the message beyond the local truth, nor lane flow.
  const remainingAfter = async (index: number): Promise<number> => {
    const local = pending.length - index - 1;
    if (!countRemaining) return local;
    try {
      return local + (await countRemaining());
    } catch {
      return local;
    }
  };
  // Every terminal outcome releases the claim, then GCs finished worktrees (#1757); fail-closed, never changes flow.
  const settle = async (issue: number, outcome: QueueReleaseOutcome): Promise<void> => {
    // Drop the in-flight mark first so this lane's own finished worktree stays reapable.
    activeIssues.delete(issue);
    await releaseIssue(issue, outcome);
    if (outcome === 'queued')
      releaseKeepOnRequeue(paths.worktreeKeeps, issue, (m) => emitEvent(paths.events, 'warn', issue, m, { lane }));
    await sweepFinished(issue).catch(() => {});
  };
  // A park raised outside runIssue upserts the issue park comment (#3534); fail-closed, never changes lane flow.
  const postParkComment = laneParkCommenter({ getOctokit, ghRepo, repoRoot, runId, lane, readParkSha }, (issue, m) =>
    emitEvent(paths.events, 'warn', issue, m, { lane }),
  );
  const pauseCtx = { lane, paths, emitEvent, now };
  // A parked release adds factory:parked (#3424). Log the clean park once the label landed; a rejected add fails (#3425).
  const parkAndSettle = async (issue: number, parkedMsg: string, park: ParkPayload): Promise<boolean> => {
    activeIssues.delete(issue);
    try {
      await releaseIssue(issue, 'parked');
    } catch (err) {
      emitEvent(
        paths.events,
        'fail',
        issue,
        `issue #${issue} park failed: could not add label '${PARKED_LABEL}' (${shipRuntime().errorDetail(err)}); lane '${lane}' continuing`,
        { lane },
      );
      await sweepFinished(issue).catch(() => {});
      return false;
    }
    emitEvent(paths.events, 'parked', issue, parkedMsg, { lane, park });
    await sweepFinished(issue).catch(() => {});
    return true;
  };
  const emitAwaitingCi = (kind: EventKind, issue: number, message: string): void =>
    emitEvent(paths.events, kind, issue, message, { lane });
  // #3208: parks an awaiting-ci PR through the lane's park path: reason event, issue comment, worktree reap, label.
  const parkAwaitingCi = async (
    rec: AwaitingCiRecord,
    reason: AwaitingCiParkReason,
    message: string,
  ): Promise<void> => {
    emitAwaitingCi(reason, rec.issue, message);
    await postParkComment(rec.issue, reason, message, rec.branch);
    await reapWorktree(rec.issue).catch(() => {});
    const msg = `issue #${rec.issue} parked (${reason}); lane '${lane}' continuing`;
    if (!(await parkAndSettle(rec.issue, msg, parkPayload(reason, workKeyFromIssue(rec.issue), lane, [])))) {
      throw new Error(`could not park issue #${rec.issue}`);
    }
    parked++;
  };
  const diskIo = { lane, paths, emitEvent, now, sleep, pathExists };
  for (let i = 0; ; i++) {
    if (await waitForProviderReset(pauseCtx, providerPauseUntil, now, sleep, pathExists)) return;
    providerPauseUntil = undefined;
    const watch = providersDownWatch;
    if (
      watch &&
      (await waitForProvidersRestored(pauseCtx, watch, { breaker: providerBreaker, configStamp, sleep, pathExists }))
    ) {
      return;
    }
    providersDownWatch = undefined;
    if (i >= pending.length) {
      // A persisted base hold on the unchanged origin/main SHA means the base is still broken (#2349):
      // stop this lane without claiming.
      const gate = baseHoldGate ? await baseHoldGate().catch((): BaseHoldDecision => ({ kind: 'claim' })) : null;
      if (gate?.kind === 'hold') {
        emitEvent(paths.events, 'warn', lane, formatBaseHoldKept(lane, gate), { lane });
        return;
      }
      if (loadGuard && (await holdForLoad(loadGuard, diskIo)) === 'stopped') break;
      if (diskGuard && (await holdForDisk(diskGuard, diskIo)) === 'stopped') break;
      if (pollReviewRework) {
        await pollReviewRework().catch((err) =>
          emitEvent(paths.events, 'warn', lane, `review-rework poll failed: ${shipRuntime().errorDetail(err)}`, {
            lane,
          }),
        );
      }
      if (recheckAwaitingCi) {
        await recheckAwaitingCi({ park: parkAwaitingCi, emit: emitAwaitingCi }).catch((err) =>
          emitEvent(paths.events, 'warn', lane, `awaiting-ci recheck failed: ${shipRuntime().errorDetail(err)}`, {
            lane,
          }),
        );
      }
      const claimed = await claimNext();
      if (claimed === null) break;
      seen.add(claimed.issue);
      pending.push(claimed);
    }
    const { issue, decision } = pending[i];
    const key = workKeyFromIssue(issue);
    activeIssues.add(issue);
    if (pathExists(paths.stop)) {
      emitEvent(paths.events, 'stopped', issue, 'STOP file present', { lane });
      activeIssues.delete(issue);
      await releaseIssue(issue, 'queued');
      return;
    }
    const lease = createClaimLease(issue, {
      leaseMs,
      now: () => now().getTime(),
      onRenewFailed: laneRenewLogger(emitEvent, paths.events, lane, issue),
    });
    const parkIssue = async (reason: string): Promise<void> => {
      emitEvent(paths.events, 'escalate', issue, reason, { lane });
      const msg = `issue #${issue} parked (${reason}); lane '${lane}' continuing, ${await remainingAfter(i)} issue(s) remaining`;
      await postParkComment(issue, 'escalate', reason, decision.kind === 'adopt' ? decision.branch : undefined);
      // A preflight-parked issue may still have a stale worktree from a prior run; the reap
      // is fail-closed and must never change lane flow.
      await reapWorktree(issue).catch(() => {});
      if (await parkAndSettle(issue, msg, parkPayload('escalate', key, lane, queuedBehind(i)))) parked++;
      streak = null;
    };
    const runRestack = (merged: { index: number; prNumber: number }) =>
      restackUnderHeartbeat(issue, heartbeat, restack, merged);
    if (decision.kind === 'park') {
      await parkIssue(decision.reason);
      continue;
    }
    if (decision.kind === 'restack') {
      const done = await runRestack({ index: decision.mergedIndex, prNumber: decision.mergedPrNumber });
      if (done.parkReason !== undefined) {
        await parkIssue(done.parkReason);
        continue;
      }
      emitEvent(paths.events, 'ship', issue, done.note, { lane });
      streak = null;
      await settle(issue, 'queued');
      continue;
    }
    const layer = decision.kind === 'adopt' ? decision.stackLayer : undefined;
    const sliceOutcome: { value?: RunOutcome } = {};
    let landBranch = decision.kind === 'adopt' ? decision.branch : undefined;
    let landing: string | undefined;
    const shipUnderLease = (ctx: { onOutcome: (o: RunOutcome) => void; rebuild?: { branch: string } }) =>
      withHeartbeat(
        issue,
        heartbeat,
        (signal) => ship(issue, {}, { repoRoot, ghRepo, paths, lane, blockedBehind: queuedBehind(i), signal, ...ctx }),
        lease,
      );
    try {
      const branch =
        decision.kind === 'adopt'
          ? decision.branch
          : await shipUnderLease({
              onOutcome: (o) => {
                sliceOutcome.value = o;
              },
            });
      landBranch = branch;
      const shipped = sliceOutcome.value;
      if (shipped?.state === 'released' && shipped.reason === 'stack-wait') {
        // ADR-0161: the slice below awaits review, so release the issue and do not park (#3367).
        awaitingReview++;
        streak = null;
        await settle(issue, 'queued');
        continue;
      }
      if (shipped?.state === 'released' && shipped.reason === 'file-overlap') {
        // #3576: another live lane owns a file this issue touches; re-queue it, never park.
        streak = null;
        await settle(issue, 'queued');
        continue;
      }
      if (shipped?.state === 'released' && shipped.reason === 'provider-cap') {
        streak = null;
        await settle(issue, 'queued');
        pauseLaneForProviderCap(pauseCtx, issue, shipped);
        providerPauseUntil = Date.parse(shipped.resetAt); // #3226: re-queued; claim nothing until then (NaN never waits)
        continue;
      }
      if (shipped?.state === 'ready' && shipped.slice && shipped.slice.index < shipped.slice.count) {
        // ADR-0147: a non-final slice's PR is open; hand the issue back for the next slice
        // instead of waiting for the merge.
        awaitingReview++;
        streak = null;
        await settle(issue, 'queued');
        continue;
      }
      if (shipped?.state === 'ready' && shipped.draft) {
        emitEvent(
          paths.events,
          'ship',
          issue,
          `PR #${shipped.prNumber} left as draft — merge skipped (draft wins over auto-merge); mark it ready for review to land it`,
          { lane },
        );
        awaitingReview++;
        streak = null;
        await settle(issue, 'done');
        continue;
      }
      if (layer) {
        // ADR-0161: land exactly this layer's branch, record it, and re-queue for the next layer.
        landing = branch;
        await withHeartbeat(
          issue,
          heartbeat,
          (signal) => waitMerge(issue, branch, repoRoot, ghRepo, paths, { landBranch: branch, signal }),
          lease,
        );
        await recordStackMerge(issue, layer.prNumber).catch((err) =>
          emitEvent(
            paths.events,
            'warn',
            issue,
            `slice ${layer.index}/${layer.count} merged but recording it failed: ${shipRuntime().errorDetail(err)}`,
            { lane },
          ),
        );
        merged++;
        if (layer.index < layer.count) {
          const done = await runRestack({ index: layer.index, prNumber: layer.prNumber });
          if (done.parkReason !== undefined) {
            await parkIssue(done.parkReason);
            continue;
          }
          emitEvent(paths.events, 'ship', issue, done.note, { lane });
        }
        streak = null;
        await settle(issue, layer.index < layer.count ? 'queued' : 'done');
        continue;
      }
      landing = branch;
      // #3325: a merge-main conflict comes back to this lane, the only builder, for one rebuild.
      await landWithOneRebuild(issue, branch, decision.kind === 'adopt' && decision.syncMain === true, {
        land: (b, opts) =>
          withHeartbeat(
            issue,
            heartbeat,
            (signal) => waitMerge(issue, b, repoRoot, ghRepo, paths, { ...opts, signal }),
            lease,
          ),
        ship: (rebuild, onOutcome) => shipUnderLease({ onOutcome, rebuild }),
        closeReplaced: closeReplacedPr,
        onRebuilt: (b) => (landing = landBranch = b),
        emit: (kind, msg, extra) => emitEvent(paths.events, kind, issue, msg, { ...extra, lane }),
      });
      merged++;
      streak = null;
      await settle(issue, 'done');
    } catch (err: any) {
      const { LaneParkError, LaneEnvironmentPauseError, IssueSkippedError, IssueDecomposedError } = shipRuntime();
      if (err instanceof ClaimLostError) {
        // #3146: another host owns the claim. Keep the worktree; never release, reap, comment or park.
        onClaimLost(err, emitEvent, paths.events, lane, hostId, runId);
        activeIssues.delete(issue);
        streak = null;
        continue;
      }
      if (err instanceof AwaitingReviewError) {
        // The land path already emitted awaiting-review and cleaned the worktree: a clean outcome, not a park.
        awaitingReview++;
        streak = null;
        await settle(issue, layer && layer.index < layer.count ? 'queued' : 'done');
        continue;
      }
      if (err instanceof AwaitingCiError) {
        // #3208: no CI run ever registered. Keep the PR open and record it for the backoff re-check; never a park.
        const firstSeenAt = now().getTime();
        const rec = { issue, prNumber: err.prNumber, branch: landBranch ?? '', headSha: err.headSha, firstSeenAt };
        await recordAwaitingCi?.({ ...rec, attempts: 0, nextRecheckAt: nextRecheckAt(firstSeenAt, 0) }).catch((e) =>
          emitAwaitingCi(
            'warn',
            issue,
            `could not record awaiting-ci for PR #${err.prNumber}: ${shipRuntime().errorDetail(e)}`,
          ),
        );
        emitAwaitingCi('awaiting-ci', issue, `PR #${err.prNumber} awaiting CI on ${err.headSha}; re-checking soon`);
        awaitingReview++;
        streak = null;
        await settle(issue, 'done');
        continue;
      }
      if (err instanceof AwaitMergeStoppedError) {
        emitEvent(paths.events, 'await-merge-stopped', issue, `${err.message}; re-queued (#3291)`, { lane });
        streak = null;
        await settle(issue, 'queued');
        continue;
      }
      if (err instanceof IssueSkippedError) {
        // shipIssue already emitted skipped-already-closed; nothing was attempted.
        skipped++;
        await settle(issue, 'done');
        continue;
      }
      if (err instanceof IssueDecomposedError) {
        // shipIssue already rewrote the queue — splice the children in after the
        // current issue so this same lane run ships them, deduping ones already queued.
        // On a GitHub lane the children are first written to the tracker (#3539); only the ones
        // that were not written are spliced in-memory, the rest are claimed next through claimNext.
        let clean = true;
        let unwritten = err.childIssues;
        if (queueChildren && err.childIssues.length > 0) {
          ({ unwritten, clean } = await queueDecomposedChildren(
            queueChildren,
            issue,
            err.childIssues,
            lane,
            paths.events,
            emitEvent,
          ));
        }
        const fresh = unwritten.filter((n) => !seen.has(n));
        for (const n of fresh) seen.add(n);
        pending.splice(i + 1, 0, ...fresh.map(buildClaim));
        if (clean) {
          decomposed++;
          emitEvent(
            paths.events,
            'decompose_filed',
            issue,
            `lane '${lane}' continuing with ${fresh.length} child issue(s) in place of #${issue}`,
            { lane },
          );
        }
        await settle(issue, 'done');
        continue;
      }
      if (err instanceof LaneEnvironmentPauseError) {
        // The base is broken, not the issue (#1928): release to queued (never parked),
        // pause the lane whatever laneBreakerThreshold is, and stop claiming.
        streak = null;
        // A preserved build is kept for `factory resume --from check` (#2564).
        if (!err.buildPreserved) await reapWorktree(issue).catch(() => {});
        await settle(issue, 'queued');
        pauseLaneForBrokenBase(pauseCtx, issue, err, ghRepo, now);
        activeIssues.delete(issue);
        return;
      }
      const reason = parkReasonFor(err);
      const logSuffix = /(?:^|\n)(Run logs: [^\r\n]+)$/.exec(String(err instanceof Error ? err.message : ''))?.[1];
      // Terminal reason events (escalate/timeout/fail/conflict) are emitted once by the detecting layer (shipIssue
      // for pipeline failures, the land path for merge failures); runLane owns only lane-lifecycle events.
      // A blocked park waits on a filed blocker (#2315); it never counts toward the lane breaker.
      const signature = err instanceof LaneParkError && err.reason !== 'blocked' ? err.failureSignature : undefined;
      const checks = err instanceof LaneParkError ? (err.failingChecks ?? []) : [];
      if (!signature) streak = null;
      else if (streak && streak.signature === signature) streak.count++;
      else streak = { signature, firstIssue: issue, failingChecks: checks, count: 1 };
      const tripped = laneBreakerThreshold > 0 && streak !== null && streak.count >= laneBreakerThreshold;
      const msg = `issue #${issue} parked (${reason})${logSuffix ? `; ${logSuffix}` : ''}; ${
        tripped ? `lane '${lane}' paused (lane breaker)` : `lane '${lane}' continuing`
      }, ${await remainingAfter(i)} issue(s) remaining`;
      // runIssue's terminalParked already wrote the comment for a run it parked (#2314).
      if (sliceOutcome.value?.state !== 'parked') {
        await postParkComment(issue, reason, err instanceof Error ? err.message : String(err), landBranch);
      }
      // Remove the parked lane's own worktree so a parked issue stops leaving a sibling
      // checkout behind (#1007); fail-closed and never allowed to change lane flow.
      if (landing !== undefined) await closeParkedPr(issue, landing, reason).catch(() => {});
      await reapWorktree(issue).catch(() => {});
      if (await parkAndSettle(issue, msg, parkPayload(reason, key, lane, queuedBehind(i)))) parked++;
      const down = sliceOutcome.value?.state === 'parked' ? sliceOutcome.value.providersDown : undefined;
      if (reason === 'all_providers_down' && down) {
        pauseLaneForAllProvidersDown(pauseCtx, issue, down);
        providersDownWatch = { providers: down.providers, configStamp: configStamp() };
        continue;
      }
      if (tripped && streak) {
        await tripLaneBreaker(pauseCtx, streak, issue, checks, commentIssue);
        return;
      }
      continue;
    }
  }
  emitEvent(
    paths.events,
    'lane-done',
    lane,
    `lane complete (${merged} merged, ${awaitingReview} awaiting review, ${skipped} skipped, ${decomposed} decomposed, ${parked} parked)`,
    { lane },
  );
}
