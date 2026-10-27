// packages/cli/src/cli/land-pr.ts — PR-level land: CI watch, main sync, SHA-pinned squash merge (#2784)

import { existsSync } from 'node:fs';

import type { Octokit } from '@octokit/rest';
import type { EventKind, FactoryEvent, ParkReason } from '@on-par/factory-core';
import type { CiOutcome, InfraRerunOutcome, WatchChecksOptions } from '@on-par/factory-core/internal';
import {
  hasAnyCiSignal,
  shellEscape,
  syncLandBranch,
  warnNoBranchProtectionOnce,
  watchChecksWithInfraRerun,
} from '@on-par/factory-core/internal';
import { MAX_LAND_SYNC_ROUNDS, probeHeadBehindBase } from './land-behind.js';
import { landRuntime } from './land-runtime.js';

export type CommandRunner = (command: string, options?: { cwd?: string; timeout?: number }) => Promise<unknown>;

export async function defaultListIssueLabels(
  octokit: Octokit,
  owner: string,
  repo: string,
  issue: number,
): Promise<string[]> {
  const { data } = await octokit.rest.issues.listLabelsOnIssue({ owner, repo, issue_number: issue });
  return data.map((label) => label.name);
}

export async function squashMergeAndDelete(
  octokit: Octokit,
  owner: string,
  repoName: string,
  branch: string,
  prNumber: number,
  /** `sha`: the CI-verified head commit. GitHub refuses the merge if the PR head has moved. */
  opts: { admin?: boolean; run?: CommandRunner; sha?: string; signal?: AbortSignal } = {},
): Promise<void> {
  opts.signal?.throwIfAborted(); // #3146: never merge once the claim is lost
  const { sha } = opts;
  if (opts.admin) {
    const run = opts.run ?? landRuntime().shellOps.exec;
    const pin = sha ? ` --match-head-commit ${shellEscape(sha)}` : '';
    await run(
      `gh pr merge ${prNumber} --repo ${shellEscape(`${owner}/${repoName}`)} --admin --squash --delete-branch${pin}`,
    );
    return;
  }

  await octokit.rest.pulls.merge({
    owner,
    repo: repoName,
    pull_number: prNumber,
    merge_method: 'squash',
    ...(sha ? { sha } : {}),
  });
  // Best-effort branch delete: the merge is the source of truth.
  await octokit.rest.git.deleteRef({ owner, repo: repoName, ref: `heads/${branch}` }).catch(() => {});
}

export class MergeGatedError extends Error {
  constructor(
    message: string,
    readonly issue: number,
    readonly prNumber: number,
    readonly label: string,
  ) {
    super(message);
    this.name = 'MergeGatedError';
  }
}

/** What the lane needs to rebuild a PR whose merge with origin/main conflicted (#3325). */
export type LandRebuild = { prNumber: number; branch: string; paths: string[]; mergeStateStatus: string };

export class LandConflictError extends Error {
  readonly parkReason: ParkReason = 'conflict';

  /** `rebuild` is set when land handed the conflict back for a rebuild instead of parking (#3325). */
  constructor(
    message: string,
    readonly rebuild?: LandRebuild,
  ) {
    super(message);
  }
}

export class AwaitingReviewError extends Error {
  constructor(
    message: string,
    readonly prNumber: number,
  ) {
    super(message);
  }
}

/** Thrown when the CI deadline passed with no check run and no commit status on the PR head (#3208). Not a
 *  CiFailedError: the PR stays open, nothing parks, and the runner re-checks it with backoff. */
export class AwaitingCiError extends Error {
  constructor(
    message: string,
    readonly prNumber: number,
    readonly headSha: string,
  ) {
    super(message);
  }
}

/** Thrown when STOP ended waitForMerge before the PR merged (#3291). Not a park: the lane
 *  re-queues the issue so the next run's preflight adopts and lands the open PR. */
export class AwaitMergeStoppedError extends Error {
  constructor(
    message: string,
    readonly branch: string,
    readonly prNumber: number | null,
  ) {
    super(message);
  }
}

export class LandFailureError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
  }
}

/** Thrown when watchChecks reports a confirmed CI failure — a completed check run with a
 *  non-passing conclusion. A confirmed failing check must never be merged, admin override
 *  or not. See CiUnverifiedError for the no-verdict case. */
export class CiFailedError extends Error {
  readonly parkReason: ParkReason = 'ci-failed';

  constructor(
    message: string,
    readonly prNumber: number,
  ) {
    super(message);
  }
}

/** Thrown when the CI watch never reached a green verdict — a deadline timeout, no check runs ever
 *  registering, or repeated API failures. A subclass of CiFailedError so every existing guard
 *  (parkReasonFor → 'ci-failed', worktree cleanup, cmdLand's exit-0 path) treats "we don't know"
 *  exactly like "we know it's red": never merge. */
export class CiUnverifiedError extends CiFailedError {}

/** Thrown when the one infra rerun (#2365) also failed for infrastructure reasons on the same head SHA (#2366).
 *  A CiFailedError subclass so every guard still leaves the PR open and unmerged, but it parks as
 *  'ci-infra', which the ADR-0155 steward skips. */
export class CiInfraError extends CiFailedError {
  override readonly parkReason: ParkReason = 'ci-infra';
}

/** True for the errors that leave the PR open and unmerged without a land failure: awaiting review, CI red or unverified, or CI not started. */
export function isLandLeftOpen(err: unknown): boolean {
  return err instanceof AwaitingReviewError || err instanceof CiFailedError || err instanceof AwaitingCiError;
}

/** True when CI never reached a green verdict: unverified, or never started. */
export function isCiNotGreen(err: unknown): boolean {
  return err instanceof CiUnverifiedError || err instanceof AwaitingCiError;
}

const MAX_MERGE_ATTEMPTS = 5;
const MERGE_RETRY_BASE_MS = 5_000;

/** True when GitHub refused a SHA-pinned merge because the PR head moved past the verified
 *  commit (REST 409, or gh's "Head branch was modified"). Retrying as-is can never succeed. */
export function isHeadModifiedMergeError(err: unknown): boolean {
  if ((err as { status?: unknown } | null)?.status === 409) return true;
  const msg = `${err instanceof Error ? err.message : ''}\n${landRuntime().errorDetail(err)}`;
  return /head branch was modified/i.test(msg);
}

export function isReviewRequiredMergeError(
  err: unknown,
  state: { mergeStateStatus?: string; reviewDecision?: string },
): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (/approving review/i.test(msg) || /review is required/i.test(msg)) return true;
  return state.mergeStateStatus === 'BLOCKED' && state.reviewDecision === 'REVIEW_REQUIRED';
}

export async function getPullRequestLandState(
  octokit: Octokit,
  owner: string,
  repoName: string,
  prNumber: number,
): Promise<{ id?: string; isDraft?: boolean; mergeStateStatus?: string; reviewDecision?: string }> {
  const result = await octokit.graphql<{
    repository?: {
      pullRequest?: { id?: string; isDraft?: boolean; mergeStateStatus?: string; reviewDecision?: string };
    };
  }>(
    `query PullRequestLandState($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          id
          isDraft
          mergeStateStatus
          reviewDecision
        }
      }
    }`,
    { owner, repo: repoName, number: prNumber },
  );
  return result.repository?.pullRequest ?? {};
}

export async function markPullRequestReady(octokit: Octokit, pullRequestId: string): Promise<void> {
  await octokit.graphql(
    `mutation MarkPullRequestReady($id: ID!) {
      markPullRequestReadyForReview(input: { pullRequestId: $id }) {
        pullRequest { isDraft }
      }
    }`,
    { id: pullRequestId },
  );
}

export async function syncDirtyPullRequest(opts: {
  issue: number;
  branch: string;
  worktree: string;
  prNumber: number;
  log: (type: EventKind, msg: string, extra?: Pick<FactoryEvent, 'paths' | 'mode'>) => void;
  run?: CommandRunner;
  pathExists?: (path: string) => boolean;
  rebuildOnConflict?: boolean;
  state?: { mergeStateStatus?: string };
}): Promise<void> {
  const { issue, branch, worktree, prNumber, log, run = landRuntime().shellOps.exec, pathExists = existsSync } = opts;

  if (!pathExists(worktree)) {
    const msg = `PR #${prNumber} DIRTY on ${branch} and worktree gone`;
    log('conflict', msg);
    throw new LandConflictError(msg);
  }

  const result = await syncLandBranch({ worktree, branch, run, log });
  if (!result.ok) {
    const { paths } = result;
    const msg = `land sync failed on ${branch}${paths.length > 0 ? ` (${paths.join(', ')})` : ''}: ${result.message}`;
    if (opts.rebuildOnConflict && paths.length > 0) {
      log('land', `${msg} — handing PR #${prNumber} back to the lane for a rebuild`);
      const mergeStateStatus = opts.state?.mergeStateStatus ?? 'UNKNOWN';
      throw new LandConflictError(`issue #${issue}: ${msg}`, { prNumber, branch, paths, mergeStateStatus });
    }
    log('conflict', `${msg} — parked`, paths.length > 0 ? { paths } : undefined);
    throw new LandConflictError(`issue #${issue}: ${msg} — parked`);
  }
}

/** A critical section runner: the land path takes this instead of owning lock composition,
 *  so the locks can be scoped to git mutations and stubbed in tests (#645). */
export type LandLock = <T>(fn: () => Promise<T>) => Promise<T>;

export async function landOpenPullRequest(opts: {
  octokit: Octokit;
  owner: string;
  repoName: string;
  ghRepo: string;
  repoRoot: string;
  issue: number;
  branch: string;
  worktree: string;
  prNumber: number;
  log: (type: EventKind, msg: string, extra?: Pick<FactoryEvent, 'paths' | 'mode'>) => void;
  run?: CommandRunner;
  pathExists?: (path: string) => boolean;
  sleep?: (ms: number) => Promise<void>;
  skipCI?: boolean;
  adminMerge?: boolean;
  watch?: (opts: WatchChecksOptions) => Promise<CiOutcome>;
  rerun?: (argv: readonly string[]) => Promise<{ ok: boolean }>;
  withLock?: LandLock;
  /** Materializes an adopted branch only after its locked state re-read confirms it needs rebasing. */
  ensureWorktree?: () => Promise<void>;
  /** #3324: preflight adopted a DIRTY or still-UNKNOWN PR; sync with main before the first CI watch even when the state is not DIRTY. */
  syncMain?: boolean;
  /** #3654: answers whether a head lacks commits from the base; undefined when unknown. Defaults to the GitHub compare API. */
  behindProbe?: (headSha: string, baseRef: string) => Promise<boolean | undefined>;
  /** #3146: aborts when the lane loses its claim; checked before the merge. */
  signal?: AbortSignal;
  /** #3325: hand a merge-main conflict on real paths back as a LandConflictError carrying `rebuild`. */
  rebuildOnConflict?: boolean;
}): Promise<void> {
  const {
    octokit,
    owner,
    repoName,
    issue,
    branch,
    worktree,
    prNumber,
    log,
    run,
    pathExists,
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    skipCI = false,
    adminMerge = process.env.FACTORY_MERGE_ADMIN === '1',
    watch = landRuntime().internalOps.watchChecks,
    rerun,
    withLock = (fn) => fn(),
    ensureWorktree,
    syncMain = false,
    rebuildOnConflict,
    behindProbe = (sha: string, base: string) => probeHeadBehindBase(octokit, owner, repoName, base, sha),
  } = opts;
  const { errorDetail } = landRuntime();

  /** Watches CI on the PR's current head commit and returns that SHA once it is green, so the
   *  merge can be pinned to exactly the commit CI verified. */
  const watchCi = async (): Promise<string> => {
    let headSha: string;
    let outcome: InfraRerunOutcome;
    try {
      const { data: pr } = await octokit.rest.pulls.get({ owner, repo: repoName, pull_number: prNumber });
      headSha = pr.head.sha;
      const baseRef = pr.base?.ref;
      outcome = await watchChecksWithInfraRerun({
        octokit,
        owner,
        repo: repoName,
        ref: headSha,
        watch,
        rerun,
        ...(baseRef ? { requiredChecks: { branch: baseRef } } : {}),
        onNoRequiredChecks: ({ branch: b }) =>
          warnNoBranchProtectionOnce(`${owner}/${repoName}`, b, (m) => log('warn', m)),
        onProgress: ({ total, completed, pending, remainingMs, waitingFor }) =>
          log(
            'land',
            waitingFor?.length
              ? `CI for PR #${prNumber}: waiting for required check${waitingFor.length > 1 ? 's' : ''} ${waitingFor.map((w) => `${w.name} (${w.state})`).join(', ')}, ${Math.ceil(remainingMs / 60_000)} min left`
              : `CI for PR #${prNumber}: ${pending} pending, ${completed}/${total} completed, ${Math.ceil(remainingMs / 60_000)} min left before the CI timeout`,
          ),
        onRescued: ({ runIds }) =>
          log(
            'ci-rescued',
            `CI rescued for PR #${prNumber} on ${branch}: reran infra-failed run(s) ${runIds.join(', ')} once and the re-watch is green`,
          ),
        onRescueFailed: ({ runIds, outcome: failedOutcome }) =>
          log(
            'ci-rescue-failed',
            `CI rescue failed for PR #${prNumber} on ${branch}: reran infra-failed run(s) ${runIds.join(', ')} once and the re-watch ended ${failedOutcome}`,
          ),
      });
    } catch (err) {
      const msg = `CI watch for ${branch} failed: ${errorDetail(err)} — refusing to merge without a green verdict`;
      log('ci-failed', msg);
      throw new CiUnverifiedError(msg, prNumber);
    }
    if (outcome === 'success') return headSha;
    if (outcome === 'infra-failure') {
      const msg = `CI failed again for infrastructure reasons for PR #${prNumber} on ${branch} after one rerun — parked as ci-infra, not merged`;
      log('ci-infra', msg);
      throw new CiInfraError(msg, prNumber);
    }
    if (outcome === 'failure') {
      const msg = `CI failed for PR #${prNumber} on ${branch} — refusing to merge with a failing check`;
      log('ci-failed', msg);
      throw new CiFailedError(msg, prNumber);
    }
    // A probe error (undefined) or any run or status keeps the unverified park: only proven silence waits.
    if (outcome === 'timeout' && (await hasAnyCiSignal(octokit, owner, repoName, headSha)) === false) {
      const msg = `no CI run or status registered on ${headSha} for PR #${prNumber} by the CI deadline — leaving the PR open and re-checking later`;
      log('awaiting-ci', msg);
      throw new AwaitingCiError(msg, prNumber, headSha);
    }
    const msg = `CI watch for ${branch} ended ${outcome} — refusing to merge without a green verdict`;
    log('ci-failed', msg);
    throw new CiUnverifiedError(msg, prNumber);
  };

  // GitHub runs no pull_request CI on a conflicting PR, so a DIRTY head is synced before the
  // first watch. Watching it first would wait out the deadline and park as ci-failed (#3533).
  let state = await getPullRequestLandState(octokit, owner, repoName, prNumber);

  const needsSync = (s: { mergeStateStatus?: string }) =>
    s.mergeStateStatus === 'DIRTY' || s.mergeStateStatus === 'BEHIND';
  let syncRounds = 0;

  /** True when `sha` (default: the PR's current head) lacks commits from the base. GitHub reports BEHIND only
   *  under strict protection, which the lander bypasses, so ask the compare API (#3654). An unknown
   *  answer warns and falls back to the mergeStateStatus rule. */
  const headIsBehind = async (sha?: string): Promise<boolean> => {
    let behind: boolean | undefined;
    try {
      const { data: pr } = await octokit.rest.pulls.get({ owner, repo: repoName, pull_number: prNumber });
      behind = await behindProbe(sha ?? pr.head.sha, pr.base?.ref ?? 'main');
    } catch {
      behind = undefined;
    }
    if (behind === undefined)
      log('warn', `behind check for PR #${prNumber} unavailable — falling back to mergeStateStatus`);
    return behind === true;
  };

  /** Why the PR must sync with main now, or undefined when it need not. Reads `state`. */
  const syncReason = async (sha?: string): Promise<'dirty' | 'behind' | undefined> => {
    if (state.mergeStateStatus === 'DIRTY') return 'dirty';
    if (needsSync(state) || (await headIsBehind(sha))) return 'behind';
    return undefined;
  };

  /** Merges main into the branch, bounded to MAX_LAND_SYNC_ROUNDS. Call under the land lock. */
  const syncNow = async (reason: string): Promise<void> => {
    if (syncRounds >= MAX_LAND_SYNC_ROUNDS) {
      const msg = `PR #${prNumber} on ${branch}: base kept moving — synced ${MAX_LAND_SYNC_ROUNDS} times and origin/main moved again; refusing to merge an unverified head`;
      log('ci-failed', msg);
      throw new CiUnverifiedError(msg, prNumber);
    }
    syncRounds++;
    await ensureWorktree?.();
    log(
      'pr_refresh',
      `PR #${prNumber} refreshed: mergeStateStatus=${state.mergeStateStatus ?? 'UNKNOWN'} action=merge-main reason=${reason} round=${syncRounds}/${MAX_LAND_SYNC_ROUNDS}`,
    );
    await syncDirtyPullRequest({ issue, branch, worktree, prNumber, log, run, pathExists, rebuildOnConflict, state });
  };

  /** Syncs a DIRTY or behind PR with main under the land lock. Returns true when it synced. */
  const syncIfStillBehind = (force = false) =>
    withLock(async () => {
      // Re-check under the lock: a sibling lane may have landed (or synced this branch)
      // while we waited for it, so the verdict read before the lock can be stale.
      state = await getPullRequestLandState(octokit, owner, repoName, prNumber);
      const reason = await syncReason();
      if (!force && !reason) return false;
      await syncNow(reason ?? 'forced');
      return true;
    });

  if (syncMain || needsSync(state) || (await headIsBehind())) await syncIfStillBehind(syncMain);

  let verifiedSha: string | undefined;

  /** One locked pass: re-checks the CI-verified head against main, then merges it. Returns false when it
   *  synced instead (the head changed, so the caller must re-watch CI before merging again). */
  const mergeVerifiedHead = async (): Promise<boolean> => {
    for (let attempt = 1; ; attempt++) {
      try {
        const outcome = await withLock(async () => {
          // Whatever we read before taking the lock (or before the backoff sleep) may be stale,
          // so the attempt decides from a fresh read.
          state = await getPullRequestLandState(octokit, owner, repoName, prNumber);
          const reason = await syncReason(verifiedSha);
          if (reason) {
            await syncNow(reason);
            return 'resynced' as const;
          }
          if (state.isDraft && state.id) {
            log('land', `PR #${prNumber} still a draft — re-issuing ready-for-review (attempt ${attempt})`);
            await markPullRequestReady(octokit, state.id).catch((err: unknown) =>
              log('warn', `ready-for-review flip failed for PR #${prNumber}: ${errorDetail(err)}`),
            );
          }
          await squashMergeAndDelete(octokit, owner, repoName, branch, prNumber, {
            admin: adminMerge,
            run,
            sha: verifiedSha,
            signal: opts.signal,
          });
          return 'merged' as const;
        });
        return outcome === 'merged';
      } catch (err: any) {
        if (err instanceof CiFailedError || err instanceof LandConflictError || opts.signal?.aborted) throw err;
        if (verifiedSha && isHeadModifiedMergeError(err)) {
          const msg = `PR #${prNumber} head moved past CI-verified commit ${verifiedSha} — refusing to merge an unverified head`;
          log('ci-failed', msg);
          throw new CiUnverifiedError(msg, prNumber);
        }
        if (isReviewRequiredMergeError(err, state)) {
          log('awaiting-review', `PR #${prNumber} blocked on human review — leaving open for approval`);
          throw new AwaitingReviewError(`PR #${prNumber} awaiting review: ${err.message}`, prNumber);
        }
        if (attempt >= MAX_MERGE_ATTEMPTS) throw err;
        log(
          'land',
          `merge attempt ${attempt}/${MAX_MERGE_ATTEMPTS} failed (${err.message}); mergeStateStatus=${state.mergeStateStatus ?? 'unknown'} — retrying with backoff`,
        );
        // Backoff outside the lock: waiting is not a mutation (#645).
        await sleep(MERGE_RETRY_BASE_MS * 2 ** (attempt - 1));
      }
    }
  };

  // The CI watch is a 10-20 minute wait, not a mutation: it must never run under the land
  // locks, or every other lane's setupWorktree serializes behind it (#645). Main may move while
  // CI runs: a head found behind under the merge lock is synced, then watched again.
  for (;;) {
    verifiedSha = skipCI ? undefined : await watchCi();
    if (await mergeVerifiedHead()) return;
  }
}
