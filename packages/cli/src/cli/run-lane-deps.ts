// packages/cli/src/cli/run-lane-deps.ts — the injectable dependencies of runLane, split out of run-lane.ts

import type { getFactoryPaths, ParkReason, ProviderBreaker, RunOutcome } from '@on-par/factory-core';
import type {
  AwaitingCiRecord,
  logEvent,
  DiskGuardDecision,
  LoadGuardDecision,
  QueueClaim,
  QueueReleaseOutcome,
  StackRestackOutcome,
} from '@on-par/factory-core/internal';
import type { Octokit } from '@octokit/rest';

import type { AwaitingCiLaneOps } from './awaiting-ci-recheck.js';
import type { BaseHoldDecision } from './base-hold.js';
import type { waitForMerge } from './land.js';
import type { ReplacedPr } from './land-rebuild.js';

export type RunLaneDeps = {
  /** Octokit for the park comment of a park raised outside runIssue (#3534). Absent = no comment. */
  octokit?: () => Octokit;
  /** The run id written to the park comment's `run:` line. Defaults to '-'. */
  runId?: string;
  /** Returns the park SHA for a branch. The default rejects, which gives `park-sha: -`. */
  readParkSha?: (branch: string) => Promise<string>;
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
      /** Issues still pending behind this one on the lane, for the park payload (#3511). */
      blockedBehind?: number[];
      onOutcome?: (outcome: RunOutcome) => void;
      /** Aborts when this issue's claim lease is lost (#3146). */
      signal?: AbortSignal;
      /** #3325: rebuild on this fresh branch from the frozen spec. */
      rebuild?: { branch: string };
    },
  ) => Promise<string>;
  waitMerge?: typeof waitForMerge;
  /** ADR-0161: records a landed stack layer as merged in the slice-plan comment. Defaults to a no-op. */
  recordStackMerge?: (issue: number, prNumber: number) => Promise<void>;
  /** ADR-0161 (#3368): rebases the open layers above a squash-merged layer onto main, model-free. Defaults to a no-op. */
  restack?: (issue: number, merged: { index: number; prNumber: number }) => Promise<StackRestackOutcome>;
  pathExists?: (path: string) => boolean;
  emitEvent?: typeof logEvent;
  claimNext?: () => Promise<QueueClaim | null>;
  /** #3563: polls open factory PRs for trusted changes-requested reviews and queues their issues; run before every remote claim.
   *  Fail-closed: a rejection is logged as a warn and never changes lane flow. Absent for local lanes. */
  pollReviewRework?: () => Promise<void>;
  /** #3208: persists the record of a PR whose CI never started (the AwaitingCiError outcome). A rejection is logged as a warn. */
  recordAwaitingCi?: (rec: AwaitingCiRecord) => Promise<void>;
  /** #3208: re-checks due awaiting-ci PRs before every claim, parking through the lane's own park path via `ops`.
   *  Fail-closed: a rejection is logged as a warn and never changes lane flow. */
  recheckAwaitingCi?: (ops: AwaitingCiLaneOps) => Promise<void>;
  releaseIssue?: (issue: number, outcome: QueueReleaseOutcome) => Promise<void>;
  /** Refreshes the claim lease every HEARTBEAT_INTERVAL_MS while an issue is in flight
   *  (#1500). Absent for static local-queue lanes, which carry no remote claim to lease. */
  heartbeat?: (issue: number) => Promise<unknown>;
  /** Claim lease length the heartbeat keeps alive (#3146). Defaults to DEFAULT_CLAIM_LEASE_MS, matching GithubQueue. */
  leaseMs?: number;
  /** This host's claimant id, reported on `claim_lost` (#3146). Defaults to defaultClaimantId(). */
  hostId?: string;
  /** Eager park-time worktree reap (#1007). Defaults to a no-op so injected-deps callers and
   *  tests are unaffected; cmdRun wires it to reapParkedLaneWorktree. */
  reapWorktree?: (issue: number) => Promise<void>;
  /** Settles the park's PR (closes it with the park reason, keeping the branch) when a park is raised while landing; default no-op. */
  closeParkedPr?: (issue: number, branch: string, reason: ParkReason) => Promise<void>;
  /** #3325: closes the conflicting PR a rebuild replaced, with a comment linking the new one. Defaults to the GitHub API. */
  closeReplacedPr?: (replaced: ReplacedPr) => Promise<void>;
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
  /** Host disk guard (#2284): consulted before every remote claim, after the load guard; 'hold' waits
   *  retryMs and re-checks (one `disk_low` event per episode). Absent = always claim. */
  diskGuard?: () => DiskGuardDecision;
  /** Breaker read while the lane is paused for all_providers_down (#3235). Defaults to the repo's breaker file. */
  providerBreaker?: Pick<ProviderBreaker, 'status'>;
  /** Stamp of the repo config file; a change ends the all_providers_down pause (#3235). Defaults to its mtime and size. */
  configStamp?: () => string;
  /** Injectable for tests. Default: setTimeout-based sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock for the logged retry time. Default: () => new Date(). */
  now?: () => Date;
};
