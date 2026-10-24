// packages/cli/src/cli/run-lane.ts — the lane loop, moved out of index.ts (#2800)

import { existsSync, statSync } from 'node:fs';

import { parkReasonFor, ProviderBreaker } from '@on-par/factory-core';
import type { getFactoryPaths, ParkPayload, RunOutcome } from '@on-par/factory-core';
import { formatLoadHold, logEvent, PARKED_LABEL, parkPayload } from '@on-par/factory-core/internal';
import type { LoadGuardDecision, QueueClaim, QueueReleaseOutcome } from '@on-par/factory-core/internal';

import { formatBaseHoldKept, type BaseHoldDecision } from './base-hold.js';
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
import { AwaitingReviewError } from './land-pr.js';
import { releaseKeepOnRequeue } from './worktree-keep.js';
import { shipIssue } from './ship.js';
import { withHeartbeat } from './lane-heartbeat.js';
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
    releaseIssue = async () => {},
    queueChildren,
    heartbeat,
    reapWorktree = async () => {},
    closeParkedPr = async () => {},
    sweepFinished = async () => {},
    activeIssues = new Set<number>(),
    countRemaining,
    baseHoldGate,
    loadGuard,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = () => new Date(),
    laneBreakerThreshold = 0,
    commentIssue = async () => {},
    octokit: getOctokit,
    runId = '-',
    readParkSha = () => Promise.reject(new Error('no park sha reader')),
    providerBreaker = new ProviderBreaker(paths.breaker),
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
  // Truthful park-time remaining count (#1222): local pending plus the lane's still-queued
  // remote issues. Fail-closed — a count lookup may never change the message beyond the
  // local truth, and never lane flow.
  const remainingAfter = async (index: number): Promise<number> => {
    const local = pending.length - index - 1;
    if (!countRemaining) return local;
    try {
      return local + (await countRemaining());
    } catch {
      return local;
    }
  };
  // Every terminal outcome releases the claim, then gives finished worktrees a GC pass before
  // the lane moves on (#1757). The pass is fail-closed and must never change lane flow.
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
  const pauseCtx = { lane, paths, emitEvent };
  // A parked release adds factory:parked (#3424). Log the clean park only once the label
  // landed; a rejected add is surfaced as a fail event naming the issue and label (#3425).
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
  const decide = (guard: () => LoadGuardDecision): LoadGuardDecision => {
    try {
      return guard();
    } catch {
      return { kind: 'claim' };
    }
  };
  const holdForLoad = async (guard: () => LoadGuardDecision): Promise<'claim' | 'stopped'> => {
    for (let d = decide(guard); d.kind === 'hold'; d = decide(guard)) {
      const retryAt = new Date(now().getTime() + d.retryMs);
      emitEvent(paths.events, 'warn', lane, formatLoadHold(lane, d, retryAt), { lane });
      await sleep(d.retryMs);
      if (pathExists(paths.stop)) return 'stopped';
    }
    return 'claim';
  };
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
      // A persisted base hold on the unchanged origin/main SHA means the base is still broken
      // (#2349): claiming would just cycle an issue again, so stop this lane without claiming.
      const gate = baseHoldGate ? await baseHoldGate().catch((): BaseHoldDecision => ({ kind: 'claim' })) : null;
      if (gate?.kind === 'hold') {
        emitEvent(paths.events, 'warn', lane, formatBaseHoldKept(lane, gate), { lane });
        return;
      }
      if (loadGuard && (await holdForLoad(loadGuard)) === 'stopped') break;
      if (pollReviewRework) {
        await pollReviewRework().catch((err) =>
          emitEvent(paths.events, 'warn', lane, `review-rework poll failed: ${shipRuntime().errorDetail(err)}`, {
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
    activeIssues.add(issue);
    if (pathExists(paths.stop)) {
      emitEvent(paths.events, 'stopped', issue, 'STOP file present', { lane });
      activeIssues.delete(issue);
      await releaseIssue(issue, 'queued');
      return;
    }
    const parkIssue = async (reason: string): Promise<void> => {
      emitEvent(paths.events, 'escalate', issue, reason, { lane });
      const msg = `issue #${issue} parked (${reason}); lane '${lane}' continuing, ${await remainingAfter(i)} issue(s) remaining`;
      await postParkComment(issue, 'escalate', reason, decision.kind === 'adopt' ? decision.branch : undefined);
      // A preflight-parked issue may still have a stale worktree from a prior run; the reap
      // is fail-closed and must never change lane flow.
      await reapWorktree(issue).catch(() => {});
      if (await parkAndSettle(issue, msg, parkPayload('escalate', issue, lane, queuedBehind(i)))) parked++;
      streak = null;
    };
    const runRestack = async (merged: {
      index: number;
      prNumber: number;
    }): Promise<{ parkReason?: string; note: string }> => {
      try {
        const out = await withHeartbeat(issue, heartbeat, () => restack(issue, merged));
        if (out.status === 'park') return { parkReason: out.reason, note: out.reason };
        return {
          note:
            out.status === 'restacked'
              ? `restacked slice(s) ${out.slices.map((r) => r.index).join(', ')} onto main after slice ${merged.index} merged`
              : out.reason,
        };
      } catch (err) {
        const reason = `restack failed: ${shipRuntime().errorDetail(err)}`;
        return { parkReason: reason, note: reason };
      }
    };
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
    try {
      const branch =
        decision.kind === 'adopt'
          ? decision.branch
          : await withHeartbeat(issue, heartbeat, () =>
              ship(
                issue,
                {},
                {
                  repoRoot,
                  ghRepo,
                  paths,
                  lane,
                  blockedBehind: queuedBehind(i),
                  onOutcome: (o) => {
                    sliceOutcome.value = o;
                  },
                },
              ),
            );
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
        await withHeartbeat(issue, heartbeat, () =>
          waitMerge(issue, branch, repoRoot, ghRepo, paths, { landBranch: branch }),
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
      await withHeartbeat(issue, heartbeat, () =>
        waitMerge(issue, branch, repoRoot, ghRepo, paths, {
          syncMain: decision.kind === 'adopt' && decision.syncMain === true,
        }),
      );
      merged++;
      streak = null;
      await settle(issue, 'done');
    } catch (err: any) {
      const { LaneParkError, LaneEnvironmentPauseError, IssueSkippedError, IssueDecomposedError } = shipRuntime();
      if (err instanceof AwaitingReviewError) {
        // The land path already emitted the awaiting-review event and cleaned the
        // worktree — this is a clean outcome, not a park; move to the next issue.
        awaitingReview++;
        streak = null;
        await settle(issue, layer && layer.index < layer.count ? 'queued' : 'done');
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
      // Terminal reason events (escalate/timeout/fail/conflict) are emitted exactly
      // once by the layer that detects the failure — shipIssue for pipeline failures,
      // the land path for merge failures. runLane owns only lane-lifecycle events
      // (stopped/parked/lane-done), so injected ship functions never change ownership.
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
      if (await parkAndSettle(issue, msg, parkPayload(reason, issue, lane, queuedBehind(i)))) parked++;
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
