// packages/cli/src/cli/run-lane.ts — the lane loop, moved out of index.ts (#2800)

import { existsSync } from 'node:fs';

import { parkReasonFor } from '@on-par/factory-core';
import type { LanePausedPayload, getFactoryPaths, RunOutcome } from '@on-par/factory-core';
import { formatLoadHold, logEvent } from '@on-par/factory-core/internal';
import type { LoadGuardDecision, QueueClaim, QueueReleaseOutcome } from '@on-par/factory-core/internal';

import { BASE_HOLD_CI_RECHECK_MS, type BaseHoldDecision, writeBaseHold } from './base-hold.js';
import { waitForMerge } from './land.js';
import { AwaitingReviewError } from './land-pr.js';
import { shipIssue } from './ship.js';
import { shipRuntime } from './ship-runtime.js';

export type RunLaneDeps = {
  /** Lane circuit breaker (#1918): pause after this many consecutive parks with the same
   *  non-empty failure signature. 0 or absent = off; cmdRun wires the resolved
   *  budget.laneBreakerThreshold. */
  laneBreakerThreshold?: number;
  /** Posts the lane-paused comment on the tripping issue (#1919). Defaults to a no-op so
   *  injected-deps callers and tests are unaffected; cmdRun wires it to issues.createComment. */
  commentIssue?: (issue: number, body: string) => Promise<void>;
  ship?: (
    issue: number,
    opts: { product?: string; autoRework?: boolean; interactive?: boolean; approvePlan?: boolean },
    ctx?: {
      repoRoot: string;
      ghRepo: string;
      paths: ReturnType<typeof getFactoryPaths>;
      lane?: string;
      onOutcome?: (outcome: RunOutcome) => void;
    },
  ) => Promise<string>;
  waitMerge?: typeof waitForMerge;
  /** ADR-0161: records a landed stack layer as merged in the slice-plan comment. Defaults to a no-op. */
  recordStackMerge?: (issue: number, prNumber: number) => Promise<void>;
  pathExists?: (path: string) => boolean;
  emitEvent?: typeof logEvent;
  claimNext?: () => Promise<QueueClaim | null>;
  releaseIssue?: (issue: number, outcome: QueueReleaseOutcome) => Promise<void>;
  /** Refreshes the claim lease every HEARTBEAT_INTERVAL_MS while an issue is in flight
   *  (#1500). Absent for static local-queue lanes, which carry no remote claim to lease. */
  heartbeat?: (issue: number) => Promise<unknown>;
  /** Eager park-time worktree reap (#1007). Defaults to a no-op so injected-deps callers and
   *  tests are unaffected; cmdRun wires it to reapParkedLaneWorktree. */
  reapWorktree?: (issue: number) => Promise<void>;
  /** Between-issues worktree GC pass (#1757), run after every terminal outcome before the
   *  lane moves on. Defaults to a no-op so injected-deps callers and tests are unaffected;
   *  cmdRun wires it to sweepBetweenLaneIssues. */
  sweepFinished?: (issue: number) => Promise<void>;
  /** Issues in flight on any lane of this run — shared across every lane of one run; an issue is in
   *  it from start to settle so no lane's sweep reaps it (#2964). */
  activeIssues?: Set<number>;
  /** Number of issues still claimable on this lane's remote queue (#1222). Absent for
   *  static local lanes, whose pending list is the whole truth. */
  countRemaining?: () => Promise<number>;
  /** Base-hold claim gate (#2349): consulted before every remote claim; 'hold' stops the lane
   *  without claiming. Absent = always claim (local lanes, injected-deps callers, tests). */
  baseHoldGate?: () => Promise<BaseHoldDecision>;
  /** Host load guard (#3048): consulted before every remote claim, after the base-hold gate; 'hold'
   *  waits retryMs and re-checks. Absent = always claim (local lanes, injected-deps callers, tests). */
  loadGuard?: () => LoadGuardDecision;
  /** Injectable for tests. Default: setTimeout-based sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock for the logged retry time. Default: () => new Date(). */
  now?: () => Date;
};

/** How often an in-flight issue's claim lease is refreshed (#1500). Well inside the
 *  15-minute default lease (github-queue.ts's DEFAULT_CLAIM_LEASE_MS) so a normal poll
 *  cadence never lets the lease lapse mid-ship. */
const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;

/** Runs `work` while periodically calling `heartbeat(issue)` so a long-running ship or
 *  merge wait keeps this claimant's lease fresh. A heartbeat failure is swallowed — losing
 *  one refresh must never abort the work it is protecting. */
async function withHeartbeat<T>(
  issue: number,
  heartbeat: ((issue: number) => Promise<unknown>) | undefined,
  work: () => Promise<T>,
): Promise<T> {
  if (!heartbeat) return work();
  const timer = setInterval(() => {
    heartbeat(issue).catch(() => {});
  }, HEARTBEAT_INTERVAL_MS);
  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
}

export function renderLanePausedComment(payload: LanePausedPayload): string {
  const checks = payload.failingChecks.length
    ? payload.failingChecks.map((c) => `\`${c}\``).join(', ')
    : 'none recorded';
  return [
    `Lane '${payload.lane}' is paused: this issue and #${payload.firstIssue} parked with the same failure signature, so the factory stopped claiming issues on this lane.`,
    `Shared failing checks: ${checks}`,
    `To resume: fix the shared failure (often on the base branch), then re-run \`factory run\` to resume lane '${payload.lane}'.`,
    `Failure signature: \`${payload.signature}\``,
  ].join('\n\n');
}

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
    pathExists = existsSync,
    emitEvent = logEvent,
    claimNext = async () => null,
    releaseIssue = async () => {},
    heartbeat,
    reapWorktree = async () => {},
    sweepFinished = async () => {},
    activeIssues = new Set<number>(),
    countRemaining,
    baseHoldGate,
    loadGuard,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = () => new Date(),
    laneBreakerThreshold = 0,
    commentIssue = async () => {},
  } = deps;
  let streak: { signature: string; firstIssue: number; failingChecks: string[]; count: number } | null = null;
  let merged = 0;
  let awaitingReview = 0;
  let skipped = 0;
  let decomposed = 0;
  let parked = 0;
  const buildClaim = (issue: number): QueueClaim => ({ issue, decision: { kind: 'build' } });
  const pending: QueueClaim[] = issues.map(buildClaim);
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
    await sweepFinished(issue).catch(() => {});
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
    if (i >= pending.length) {
      // A persisted base hold on the unchanged origin/main SHA means the base is still broken
      // (#2349): claiming would just cycle an issue again, so stop this lane without claiming.
      const gate = baseHoldGate ? await baseHoldGate().catch((): BaseHoldDecision => ({ kind: 'claim' })) : null;
      if (gate?.kind === 'hold') {
        emitEvent(
          paths.events,
          'warn',
          lane,
          `lane '${lane}' not claiming: base hold on ${gate.hold.baseSha.slice(0, 8)} (${gate.hold.failingChecks.join(', ')}) — origin/main unchanged and its CI is not green${gate.ciReason ? ` (${gate.ciReason})` : ''}`,
          { lane },
        );
        return;
      }
      if (loadGuard && (await holdForLoad(loadGuard)) === 'stopped') break;
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
    if (decision.kind === 'park') {
      emitEvent(paths.events, 'escalate', issue, decision.reason, { lane });
      emitEvent(
        paths.events,
        'parked',
        issue,
        `issue #${issue} parked (${decision.reason}); lane '${lane}' continuing, ${await remainingAfter(i)} issue(s) remaining`,
        { lane },
      );
      // A preflight-parked issue may still have a stale worktree from a prior run; the reap
      // is fail-closed and must never change lane flow.
      await reapWorktree(issue).catch(() => {});
      await settle(issue, 'parked');
      parked++;
      streak = null;
      continue;
    }
    const layer = decision.kind === 'adopt' ? decision.stackLayer : undefined;
    try {
      const sliceOutcome: { value?: RunOutcome } = {};
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
                  onOutcome: (o) => {
                    sliceOutcome.value = o;
                  },
                },
              ),
            );
      const shipped = sliceOutcome.value;
      if (shipped?.state === 'released' && shipped.reason === 'stack-wait') {
        // ADR-0161: the slice below awaits review, so release the issue and do not park (#3367).
        awaitingReview++;
        streak = null;
        await settle(issue, 'queued');
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
      if (layer) {
        // ADR-0161: land exactly this layer's branch, record it, and re-queue for the next layer.
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
        streak = null;
        await settle(issue, layer.index < layer.count ? 'queued' : 'done');
        continue;
      }
      await withHeartbeat(issue, heartbeat, () => waitMerge(issue, branch, repoRoot, ghRepo, paths));
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
        const fresh = err.childIssues.filter((n) => !seen.has(n));
        for (const n of fresh) seen.add(n);
        pending.splice(i + 1, 0, ...fresh.map(buildClaim));
        decomposed++;
        emitEvent(
          paths.events,
          'decompose_filed',
          issue,
          `lane '${lane}' continuing with ${fresh.length} child issue(s) in place of #${issue}`,
          { lane },
        );
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
        // Persist the hold so a restarted supervisor remembers the broken base (#2348);
        // best-effort, never allowed to change lane flow.
        try {
          writeBaseHold(paths.baseHold, {
            repo: ghRepo,
            baseSha: err.baseSha,
            failingChecks: err.failingChecks,
            since: new Date().toISOString(),
            ...(err.awaitingCi
              ? { ciRecheckAfter: new Date(now().getTime() + BASE_HOLD_CI_RECHECK_MS).toISOString() }
              : {}),
            ...(err.confirmedLocally ? { confirmedLocally: true as const } : {}),
          });
        } catch {}
        const payload: LanePausedPayload = {
          lane,
          signature: err.failureSignature ?? '',
          failingChecks: err.failingChecks,
          firstIssue: issue,
          secondIssue: issue,
          cause: 'environment',
          baseSha: err.baseSha,
        };
        emitEvent(
          paths.events,
          'lane-paused',
          lane,
          `lane '${lane}' paused: #${issue} failed only on checkers that also fail on base ${err.baseSha.slice(0, 8)} (${err.failingChecks.join(', ')}); #${issue} released to queued`,
          { lane, lanePaused: payload },
        );
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
      emitEvent(
        paths.events,
        'parked',
        issue,
        `issue #${issue} parked (${reason})${logSuffix ? `; ${logSuffix}` : ''}; ${
          tripped ? `lane '${lane}' paused (lane breaker)` : `lane '${lane}' continuing`
        }, ${await remainingAfter(i)} issue(s) remaining`,
        { lane },
      );
      // Remove the parked lane's own worktree so a parked issue stops leaving a sibling
      // checkout behind (#1007); fail-closed and never allowed to change lane flow.
      await reapWorktree(issue).catch(() => {});
      await settle(issue, 'parked');
      parked++;
      if (tripped && streak) {
        const { signature: tripSignature, firstIssue, failingChecks: firstChecks } = streak;
        const payload: LanePausedPayload = {
          lane,
          signature: tripSignature,
          failingChecks: checks.filter((c) => firstChecks.includes(c)),
          firstIssue,
          secondIssue: issue,
        };
        emitEvent(
          paths.events,
          'lane-paused',
          lane,
          `lane '${lane}' paused: #${payload.firstIssue} and #${payload.secondIssue} parked with the same failure signature (${payload.failingChecks.join(', ') || 'no failing checks'})`,
          { lane, lanePaused: payload },
        );
        // Tell the developer on GitHub why the lane stopped (#1919); fail-closed, never changes lane flow.
        await commentIssue(payload.secondIssue, renderLanePausedComment(payload)).catch(() => {});
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
