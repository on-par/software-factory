// packages/cli/src/cli/land.ts — issue-level land flow: resolve the PR, honor the merge gate, land it (#2784)

import { existsSync } from 'node:fs';

import type { Octokit } from '@octokit/rest';
import type { EventKind, FactoryConfig, FailoverReason, MergePolicyOverrides } from '@on-par/factory-core';
import type { getFactoryPaths } from '@on-par/factory-core';
import {
  LaneFileGuard,
  phaseSnapshotFile,
  resolveMergePolicy,
  resolveSandboxPolicy,
  touchRunActivity,
} from '@on-par/factory-core';
import type { WorktreeSandbox } from '@on-par/factory-core/internal';
import {
  branchFor,
  factoryBranchPrefixes,
  getIssueTitle,
  isAutoMergeBlocked,
  LEGACY_BRANCH_PREFIX,
  logEvent,
  publishRiskReceipt,
  releaseLaneClaim,
  resolveEffectiveConfig,
  resolveFilingPolicy,
  withFileLock,
  withGitLock,
  worktreeSandboxFor,
} from '@on-par/factory-core/internal';
import type { OpenPullRequestEvidence } from './index.js';
import {
  AwaitingReviewError,
  CiFailedError,
  LandConflictError,
  LandFailureError,
  MergeGatedError,
  landOpenPullRequest,
} from './land-pr.js';
import type { LandLock } from './land-pr.js';
import { landRuntime } from './land-runtime.js';
import { riskPolicyLines } from './risk-policy.js';

async function releaseLandedClaim(
  paths: ReturnType<typeof getFactoryPaths>,
  ghRepo: string,
  issue: number,
  log: (type: EventKind, msg: string) => void,
): Promise<void> {
  if (!paths.laneFiles) return;
  await releaseLaneClaim(new LaneFileGuard(paths.laneFiles), ghRepo, issue, log);
}

export async function landIssue(
  issueNum: number,
  repoRoot: string,
  ghRepo: string,
  paths: ReturnType<typeof getFactoryPaths>,
  octokit: Octokit,
  skipCI?: boolean,
  branchPrefix?: string,
  opts: { allowGated?: boolean; branch?: string } = {},
): Promise<{ branch: string; prNumber: number }> {
  const { configLoaders, gitOps, errorDetail, worktreePathFor } = landRuntime();
  const [owner, repoName] = ghRepo.split('/');
  const log = (type: EventKind, msg: string, extra?: { failoverReason?: FailoverReason }) =>
    logEvent(paths.events, type, issueNum, msg, extra);

  // The issue title may have been edited since the PR was opened, so a
  // freshly-derived branch name can drift from the branch the PR actually
  // lives on (same failure mode fixed for waitForMerge in #51). Guess the
  // branch from the current title first, but fall back to matching the open
  // PR that references this issue directly and use its real head branch.
  // Legacy-prefix (LEGACY_BRANCH_PREFIX) branches are guessed too, after the resolved prefix (#1708).
  const resolved = branchPrefix ?? resolveEffectiveConfig(configLoaders.loadRepoConfig(repoRoot)).branchPrefix;
  const title = await getIssueTitle(ghRepo, issueNum, octokit);
  // ADR-0161: a stack layer lands by its exact branch, never by title guess or the Closes PR (the top layer).
  const guesses = opts.branch
    ? [opts.branch]
    : factoryBranchPrefixes(resolved).map((p) => branchFor(issueNum, title, p));
  const guessedBranch = guesses[0];

  let branch = guessedBranch;
  let prNumber: number | undefined;
  try {
    const findByGuess = async (): Promise<number | undefined> => {
      for (const guess of guesses) {
        const found = await findOpenPRNumber(octokit, owner, repoName, guess);
        if (found) {
          branch = guess;
          return found;
        }
      }
      return undefined;
    };
    [, prNumber] = await Promise.all([gitOps.gitFetch(repoRoot), findByGuess()]);
    if (!prNumber && !opts.branch) {
      const fallback = await findOpenPRForIssue(octokit, owner, repoName, issueNum);
      if (fallback) {
        branch = fallback.branch;
        prNumber = fallback.number;
      }
    }
  } catch (err) {
    const failure = prLookupFailure(issueNum, guessedBranch, err);
    log('fail', failure.message);
    throw failure;
  }

  if (!prNumber) {
    log('fail', `no open PR for ${guessedBranch}`);
    throw new LandFailureError(`no open PR for issue #${issueNum} (${guessedBranch})`, 1);
  }

  const landFactoryConfig = configLoaders.loadFactoryConfigForRepo(paths.config);
  // Every merge path honors the no-auto-merge gate on the issue and on the PR; unreadable labels fail closed (#1720).
  const filingPolicy = resolveFilingPolicy(landFactoryConfig);
  const gateLabel = filingPolicy.selfFixLabel;
  if (opts.allowGated) {
    console.log(
      `AUDIT factory land #${issueNum}: --allow-gated override — merging PR #${prNumber} past the ${gateLabel} gate`,
    );
    log('merge-gated-override', `--allow-gated: merging PR #${prNumber} past ${gateLabel} gate (human override)`);
  } else {
    let where: string | undefined;
    try {
      const [issueLabels, prLabels] = await Promise.all([
        defaultListIssueLabels(octokit, owner, repoName, issueNum),
        defaultListIssueLabels(octokit, owner, repoName, prNumber),
      ]);
      if (isAutoMergeBlocked(issueLabels, filingPolicy)) where = `issue #${issueNum} is labelled ${gateLabel}`;
      else if (isAutoMergeBlocked(prLabels, filingPolicy)) where = `PR #${prNumber} is labelled ${gateLabel}`;
    } catch (err) {
      where = `labels could not be read (${errorDetail(err)}) — failing closed on the ${gateLabel} gate`;
    }
    if (where) {
      log('merge-gated', `land refused: ${where}`);
      throw new MergeGatedError(
        `not merging PR #${prNumber} for issue #${issueNum}: ${where} (human approval required). Re-run \`factory land ${issueNum} --allow-gated\` to merge it deliberately.`,
        issueNum,
        prNumber,
        gateLabel,
      );
    }
  }

  // Risk policy (#3387) and receipt (#3386): best-effort, never blocks or changes the merge.
  const riskPolicy = riskPolicyLines(repoRoot);
  for (const line of riskPolicy.lines) console.log(line);
  try {
    const receipt = await publishRiskReceipt({
      octokit,
      owner,
      repo: repoName,
      prNumber,
      ...(riskPolicy.rules ? { rules: riskPolicy.rules } : {}),
    });
    log(
      'land',
      `risk receipt ${receipt.updated ? 'published' : 'unchanged'} on PR #${prNumber}: tier ${receipt.evaluation.tier}`,
    );
  } catch (err) {
    log('warn', `could not publish the risk receipt on PR #${prNumber}: ${errorDetail(err)}`);
  }

  const worktree = worktreePathFor(
    repoRoot,
    ghRepo,
    issueNum,
    branch.startsWith(`${LEGACY_BRANCH_PREFIX}/`) ? LEGACY_BRANCH_PREFIX : resolved,
  );
  const landSandboxPolicy = resolveSandboxPolicy(landFactoryConfig.sandbox, {
    worktree,
    repoRoot,
  });
  const worktreeSandbox: WorktreeSandbox | undefined = worktreeSandboxFor(landSandboxPolicy?.runtime, {
    allowHosts: landSandboxPolicy?.allowHosts ?? [],
  });

  const withLandLock: LandLock = (fn) =>
    withGitLock(repoRoot, () =>
      withFileLock(paths.mergeLock, fn, {
        onSteal: (pid) => log('lock-stolen', `stole ${paths.mergeLock} from dead holder pid ${pid ?? 'unknown'}`),
      }),
    );

  try {
    try {
      await landOpenPullRequest({
        octokit,
        owner,
        repoName,
        ghRepo,
        repoRoot,
        issue: issueNum,
        branch,
        worktree,
        prNumber: prNumber!,
        log,
        skipCI,
        adminMerge: resolveMergePolicy(landFactoryConfig).admin,
        withLock: withLandLock,
        ensureWorktree: async () => {
          if (!existsSync(worktree)) {
            await gitOps.setupWorktree(repoRoot, branch, worktree, `origin/${branch}`, worktreeSandbox, log);
          }
        },
      });
    } catch (err) {
      if (err instanceof AwaitingReviewError || err instanceof CiFailedError) {
        await withLandLock(() => gitOps.cleanupWorktree(repoRoot, worktree, log, worktreeSandbox));
      }
      throw err;
    }
    log('merged', `squash-merged PR #${prNumber}`);
    await releaseLandedClaim(paths, ghRepo, issueNum, log);
    await withLandLock(() => gitOps.cleanupWorktree(repoRoot, worktree, log, worktreeSandbox));
  } catch (err: any) {
    if (err instanceof LandConflictError || err instanceof AwaitingReviewError || err instanceof CiFailedError)
      throw err;
    log('fail', `merge failed: ${err.message}`);
    throw new LandFailureError(`merge failed for issue #${issueNum}: ${err.message}`, 5);
  }

  return { branch, prNumber };
}

export function prLookupFailure(issueNum: number, branch: string, err: unknown): LandFailureError {
  return new LandFailureError(
    `PR lookup failed for issue #${issueNum} (${branch}): ${landRuntime().errorDetail(err)}`,
    5,
  );
}

export async function isPrMerged(octokit: Octokit, owner: string, repoName: string, branch: string): Promise<boolean> {
  const { data: prs } = await octokit.rest.pulls.list({
    owner,
    repo: repoName,
    state: 'all',
    head: `${owner}:${branch}`,
  });
  if (prs.length === 0) return false;
  // Ship-it branch names get reused across separate runs for the same issue
  // (e.g. a "verify-and-close" pass recreates the exact branch name an
  // earlier, already-merged PR used) — GitHub PR numbers only increase, so
  // the highest-numbered PR under this head is always the current one.
  // Checking "was ANY PR ever merged under this branch name" (the old
  // `state: 'closed'` + `.some()` behavior) matched the stale prior PR and
  // falsely reported a brand-new, still-open PR under the same name as
  // merged — waitForMerge then logged "landed" and skipped calling land(),
  // leaving the real PR open forever while the lane believed it was done.
  const latest = prs.reduce((newest: any, pr: any) => (pr.number > newest.number ? pr : newest));
  return Boolean(latest.merged_at);
}

export async function findOpenPRNumber(
  octokit: Octokit,
  owner: string,
  repoName: string,
  branch: string,
): Promise<number | undefined> {
  const { data: prs } = await octokit.rest.pulls.list({
    owner,
    repo: repoName,
    state: 'open',
    head: `${owner}:${branch}`,
  });
  return prs[0]?.number;
}

export async function findOpenPRForIssue(
  octokit: Octokit,
  owner: string,
  repoName: string,
  issueNum: number,
): Promise<OpenPullRequestEvidence | undefined> {
  const perPage = 100;
  const matches = new RegExp(`\\bcloses\\s+#${issueNum}\\b`, 'i');
  for (let page = 1; ; page++) {
    const { data: prs } = await octokit.rest.pulls.list({
      owner,
      repo: repoName,
      state: 'open',
      per_page: perPage,
      page,
    });
    const pr = prs.find((p: any) => matches.test(p.body ?? ''));
    if (pr) {
      const headRepoFullName = pr.head.repo?.full_name ?? null;
      if (headRepoFullName !== `${owner}/${repoName}`) {
        return {
          number: pr.number,
          branch: pr.head.ref,
          headSha: pr.head.sha,
          headRepoFullName,
        };
      }
      return { number: pr.number, branch: pr.head.ref, headSha: pr.head.sha, headRepoFullName };
    }
    if (prs.length < perPage) return undefined;
  }
}

/** Consecutive merged-state check failures tolerated before waitForMerge parks the lane.
 *  At the shipped 120s poll that is ~20 minutes of 100% failure (ADR: sustained-failure park). */
export const MERGE_CHECK_MAX_CONSECUTIVE_FAILURES = 10;

/** Wall-clock backstop: continuous merged-state check failure for this long parks the lane even
 *  if fewer than MERGE_CHECK_MAX_CONSECUTIVE_FAILURES attempts were made (slower poll cadence). */
export const MERGE_CHECK_FAILURE_BUDGET_MS = 2 * 60 * 60 * 1000;

/** GitHub signals both primary and secondary rate limits with 403 — the same status it uses for a
 *  token that genuinely lacks the scope. Only a 403 with no rate-limit evidence is permanent. */
function looksRateLimited(err: unknown): boolean {
  const headers = (err as { response?: { headers?: Record<string, unknown> } } | null)?.response?.headers ?? {};
  const remaining = headers['x-ratelimit-remaining'];
  if (typeof remaining === 'string' && remaining.trim() === '0') return true;
  if (typeof remaining === 'number' && remaining === 0) return true;
  if (headers['retry-after'] !== undefined) return true;
  return /rate limit|secondary rate|abuse detection/i.test(landRuntime().errorDetail(err));
}

/** True when a merged-state check failure cannot recover by retrying: an expired/revoked token
 *  (401) or a token missing `pulls:read` (403 with no rate-limit evidence). */
export function isPermanentMergeCheckError(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  if (status === 401) return true;
  if (status !== 403) return false;
  return !looksRateLimited(err);
}

export type WaitForMergeDeps = {
  createOctokit?: () => Octokit;
  pathExists?: (path: string) => boolean;
  checkMerged?: typeof isPrMerged;
  loadConfig?: (configPath: string) => FactoryConfig;
  land?: (
    issueNum: number,
    repoRoot: string,
    ghRepo: string,
    paths: ReturnType<typeof getFactoryPaths>,
    octokit: Octokit,
    skipCI?: boolean,
    branchPrefix?: string,
    opts?: { allowGated?: boolean; branch?: string },
  ) => Promise<{ branch: string; prNumber: number }>;
  /** ADR-0161 stack layer: land exactly this head branch. */
  landBranch?: string;
  listIssueLabels?: (octokit: Octokit, owner: string, repo: string, issue: number) => Promise<string[]>;
  sleep?: (ms: number) => Promise<void>;
  emitEvent?: typeof logEvent;
  mergeEnabled?: () => boolean;
  writeLine?: (line: string) => void;
  /** Injectable clock so the wall-clock failure budget is testable. Default `() => Date.now()`. */
  now?: () => number;
  /** Per-invocation CLI flag overrides (`--auto-merge`/`--no-auto-merge`). Threaded in by
   *  cmdRun rather than read from disk so a live run's merge gate cannot change underneath
   *  it (#1400). */
  mergeOverrides?: MergePolicyOverrides;
};

async function defaultListIssueLabels(octokit: Octokit, owner: string, repo: string, issue: number): Promise<string[]> {
  const { data } = await octokit.rest.issues.listLabelsOnIssue({ owner, repo, issue_number: issue });
  return data.map((label) => label.name);
}

export async function waitForMerge(
  issue: number,
  branch: string,
  repoRoot: string,
  ghRepo: string,
  paths: ReturnType<typeof getFactoryPaths>,
  deps: WaitForMergeDeps = {},
): Promise<void> {
  const {
    createOctokit = landRuntime().getOctokit,
    pathExists = existsSync,
    checkMerged = isPrMerged,
    loadConfig = landRuntime().configLoaders.loadFactoryConfigForRepo,
    land = landIssue,
    listIssueLabels = defaultListIssueLabels,
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    emitEvent = logEvent,
    mergeEnabled,
    writeLine = (line) => console.log(line),
    now = () => Date.now(),
    mergeOverrides,
    landBranch,
  } = deps;
  const { configLoaders, errorDetail, LaneParkError } = landRuntime();
  const factoryConfig = loadConfig(paths.config);
  const isMergeEnabled = mergeEnabled ?? (() => resolveMergePolicy(factoryConfig, process.env, mergeOverrides).auto);
  const skipCI = configLoaders.resolveSkipCI(factoryConfig);
  const filingPolicy = resolveFilingPolicy(factoryConfig);
  const octokit = createOctokit();
  const [owner, repoName] = ghRepo.split('/');

  emitEvent(paths.events, 'await-merge', issue, `waiting to merge ${branch}`);
  let consecutiveFailures = 0;
  let firstFailureAt: number | null = null;
  while (!pathExists(paths.stop)) {
    // The merge wait logs nothing on its happy path, so each poll bumps the per-issue heartbeat:
    // status/TUI staleness rules (ADR-0086, ADR-0093) otherwise read a live wait as a dead run.
    if (paths.runs) touchRunActivity(phaseSnapshotFile(paths.runs, issue), new Date().toISOString()).catch(() => {});
    let merged = false;
    try {
      merged = await checkMerged(octokit, owner, repoName, branch);
      consecutiveFailures = 0;
      firstFailureAt = null;
    } catch (err) {
      consecutiveFailures++;
      firstFailureAt ??= now();
      const detail = errorDetail(err);
      emitEvent(paths.events, 'warn', issue, `merged-state check failed (treating as not merged): ${detail}`);

      const permanent = isPermanentMergeCheckError(err);
      const elapsedMs = now() - firstFailureAt;
      const budgetSpent = elapsedMs >= MERGE_CHECK_FAILURE_BUDGET_MS;
      const streakSpent = consecutiveFailures >= MERGE_CHECK_MAX_CONSECUTIVE_FAILURES;
      if (permanent || streakSpent || budgetSpent) {
        const trigger = permanent
          ? 'permanent error (auth/scope — retrying cannot help)'
          : `${consecutiveFailures} consecutive failures over ${Math.round(elapsedMs / 1000)}s`;
        const msg = `merged-state check for ${branch} is not recovering — parking lane after ${trigger}: ${detail}`;
        emitEvent(paths.events, 'escalate', issue, msg);
        throw new LaneParkError(msg, 'escalate');
      }
    }
    if (merged) {
      emitEvent(paths.events, 'landed', issue, 'PR merged');
      return;
    }

    if (isMergeEnabled()) {
      let labels: string[] = [];
      try {
        labels = await listIssueLabels(octokit, owner, repoName, issue);
      } catch (err) {
        emitEvent(paths.events, 'warn', issue, `label check failed (treating as blocked): ${errorDetail(err)}`);
        labels = [filingPolicy.selfFixLabel];
      }
      if (isAutoMergeBlocked(labels, filingPolicy)) {
        emitEvent(
          paths.events,
          'merge-gated',
          issue,
          `auto-merge blocked by ${filingPolicy.selfFixLabel} — awaiting human approval`,
        );
        writeLine(
          `[factory] #${issue} auto-merge gated (${filingPolicy.selfFixLabel}); awaiting human merge (poll 120s)`,
        );
        await sleep(120_000);
        continue;
      }
      if (landBranch) await land(issue, repoRoot, ghRepo, paths, octokit, skipCI, undefined, { branch: landBranch });
      else await land(issue, repoRoot, ghRepo, paths, octokit, skipCI);
      await releaseLandedClaim(paths, ghRepo, issue, (type, msg) => emitEvent(paths.events, type, issue, msg));
      return;
    }

    writeLine(`[factory] #${issue} awaiting human merge (poll 120s)`);
    await sleep(120_000);
  }
}
