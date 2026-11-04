// packages/cli/src/cli/ci-pending-draft-sweep.ts — land or CI-rework factory drafts SHIP left for pending CI (#3932)
//
// SHIP leaves a PR as a draft when its CI watch window ends before a verdict, and records `draftReason:
// 'ci-pending'` on the trusted PR run-state comment. This sweep, run at `factory run` start and between lane
// issues, lands such a draft once CI is green, queues CI rework when CI is red and leaves it while CI still runs.
// Drafts made on purpose (--draft-pr, run.pr.draft, a human) carry no such reason and are never touched.

import type { Octokit } from '@octokit/rest';

import { loadFactoryConfigForRepo, resolveMergePolicy, workKeyFromIssue, type EventKind } from '@on-par/factory-core';
import type { getFactoryPaths } from '@on-par/factory-core';
import {
  createFileIterateStore,
  createOctokitQueueClient,
  factoryBranchIssue,
  loadPrRunState,
  logEvent,
  queueCiPendingRework,
  resolveBranchPrefix,
  savePrRunState,
  watchChecks,
  type CiOutcome,
  type PrRunState,
} from '@on-par/factory-core/internal';
import { MergeGatedError, markPullRequestReady } from './land-pr.js';
import { waitForMerge } from './land.js';

export type CiPendingDraftAction =
  'landed' | 'merge-gated' | 'marked-ready' | 'land-failed' | 'ci-rework' | 'still-pending' | 'skipped';

export interface CiPendingDraftResult {
  pr: number;
  issue: number;
  action: CiPendingDraftAction;
  detail?: string;
}

export interface CiPendingDraftSweepDeps {
  octokit: Octokit;
  ghRepo: string;
  branchPrefix: string;
  /** Issues a lane holds right now; their drafts are never touched. */
  protectedIssues?: ReadonlySet<number>;
  mergeEnabled: () => boolean;
  probeCi: (pr: { headSha: string; baseRef: string }) => Promise<CiOutcome>;
  markReady: (pullRequestNodeId: string) => Promise<void>;
  land: (issue: number, branch: string) => Promise<void>;
  queueRework: (issue: number, pr: number) => Promise<{ outcome: 'queued' | 'skipped' | 'error'; detail?: string }>;
  log: (type: EventKind, issue: number, msg: string) => void;
}

const PAGE_SIZE = 100;
const MAX_PAGES = 50;
const PROBE_DEADLINE_MS = 60_000;

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

type OpenPull = Awaited<ReturnType<Octokit['rest']['pulls']['list']>>['data'][number];

async function listOpenPulls(octokit: Octokit, ghRepo: string): Promise<OpenPull[]> {
  const [owner = '', repo = ''] = ghRepo.split('/');
  const pulls: OpenPull[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { data } = await octokit.rest.pulls.list({ owner, repo, state: 'open', per_page: PAGE_SIZE, page });
    pulls.push(...data);
    if (data.length < PAGE_SIZE) break;
  }
  return pulls;
}

/** Drops the CI-pending reason so the PR is never picked up twice. A save failure is logged, never fatal. */
async function clearReason(deps: CiPendingDraftSweepDeps, pr: number, issue: number, state: PrRunState): Promise<void> {
  const { draftReason: _cleared, ...rest } = state;
  try {
    await savePrRunState({
      octokit: deps.octokit,
      repo: deps.ghRepo,
      prNumber: pr,
      state: { ...rest, status: 'awaiting-review', updatedAt: new Date().toISOString() },
    });
  } catch (err) {
    deps.log('pr_state_failed', issue, `could not clear the CI-pending reason on PR #${pr}: ${errorMessage(err)}`);
  }
}

async function handleDraft(
  deps: CiPendingDraftSweepDeps,
  pull: OpenPull,
  issue: number,
  state: PrRunState,
): Promise<CiPendingDraftResult> {
  const { log } = deps;
  const pr = pull.number;
  let verdict: CiOutcome;
  try {
    verdict = await deps.probeCi({ headSha: pull.head.sha, baseRef: pull.base.ref });
  } catch (err) {
    log('warn', issue, `CI probe for CI-pending draft PR #${pr} failed: ${errorMessage(err)}`);
    return { pr, issue, action: 'still-pending', detail: errorMessage(err) };
  }
  if (verdict === 'timeout') {
    log('ship', issue, `PR #${pr}: CI still pending; left as draft`);
    return { pr, issue, action: 'still-pending' };
  }
  if (verdict === 'failure') {
    const queued = await deps.queueRework(issue, pr);
    if (queued.outcome !== 'queued') {
      const detail = queued.detail ?? queued.outcome;
      log('warn', issue, `CI failed on CI-pending draft PR #${pr} but #${issue} was not queued for rework: ${detail}`);
      return { pr, issue, action: 'skipped', detail };
    }
    await clearReason(deps, pr, issue, state);
    log('rework', issue, `CI failed on CI-pending draft PR #${pr}; queued #${issue} for CI rework`);
    return { pr, issue, action: 'ci-rework' };
  }
  await clearReason(deps, pr, issue, state);
  await deps.markReady(pull.node_id);
  log('ready', issue, `PR #${pr} marked ready: CI passed after SHIP left it as a draft`);
  if (!deps.mergeEnabled()) {
    log('merge-gated', issue, `auto-merge off by merge policy; PR #${pr} left ready for a human`);
    return { pr, issue, action: 'merge-gated' };
  }
  try {
    await deps.land(issue, pull.head.ref);
    return { pr, issue, action: 'landed' };
  } catch (err) {
    if (err instanceof MergeGatedError) return { pr, issue, action: 'merge-gated', detail: err.message };
    log('warn', issue, `landing CI-pending draft PR #${pr} failed: ${errorMessage(err)}`);
    return { pr, issue, action: 'land-failed', detail: errorMessage(err) };
  }
}

/** Never throws. Returns one result per factory draft it acted on or deliberately left. */
export async function sweepCiPendingDrafts(deps: CiPendingDraftSweepDeps): Promise<CiPendingDraftResult[]> {
  const { octokit, ghRepo, branchPrefix, protectedIssues } = deps;
  let pulls: OpenPull[];
  try {
    pulls = await listOpenPulls(octokit, ghRepo);
  } catch (err) {
    deps.log('warn', 0, `CI-pending draft sweep could not list open PRs: ${errorMessage(err)}`);
    return [];
  }
  const results: CiPendingDraftResult[] = [];
  for (const pull of pulls) {
    if (!pull.draft || !pull.head.ref.startsWith(`${branchPrefix}/`)) continue;
    const issue = factoryBranchIssue(pull.head.ref, branchPrefix);
    if (issue === null || protectedIssues?.has(issue)) continue;
    try {
      const loaded = await loadPrRunState({
        octokit,
        repo: ghRepo,
        prNumber: pull.number,
        key: workKeyFromIssue(issue),
      });
      if (loaded.status !== 'found' || loaded.state.draftReason !== 'ci-pending') continue;
      if (loaded.state.prNumber !== pull.number) continue;
      results.push(await handleDraft(deps, pull, issue, loaded.state));
    } catch (err) {
      deps.log('warn', issue, `CI-pending draft sweep failed on PR #${pull.number}: ${errorMessage(err)}`);
    }
  }
  return results;
}

/** Options for the production wrapper; `lane` and `protectedIssues` are set between lane issues. */
export interface CiPendingDraftSweepOpts {
  repoRoot?: string;
  protectedIssues?: ReadonlySet<number>;
  lane?: string;
  autoMerge?: boolean;
  /** Test seam: the land path; defaults to waitForMerge. */
  waitMerge?: typeof waitForMerge;
}

/** The production wiring of the sweep. Never throws — a failure is a warn, never a reason to abort `factory run`. */
export async function runCiPendingDraftSweep(
  paths: ReturnType<typeof getFactoryPaths>,
  ghRepo: string,
  getOctokit: () => Octokit | undefined,
  opts: CiPendingDraftSweepOpts = {},
): Promise<void> {
  const log = (type: EventKind, issue: number, msg: string): void =>
    logEvent(paths.events, type, issue === 0 ? 'all' : issue, msg, opts.lane ? { lane: opts.lane } : undefined);
  try {
    const octokit = getOctokit();
    if (!octokit) return;
    const [owner = '', repo = ''] = ghRepo.split('/');
    const config = loadFactoryConfigForRepo(paths.config);
    const { autoMerge, waitMerge = waitForMerge } = opts;
    const results = await sweepCiPendingDrafts({
      octokit,
      ghRepo,
      branchPrefix: resolveBranchPrefix(config),
      ...(opts.protectedIssues ? { protectedIssues: opts.protectedIssues } : {}),
      mergeEnabled: () =>
        resolveMergePolicy(config, process.env, autoMerge === undefined ? undefined : { auto: autoMerge }).auto,
      probeCi: ({ headSha, baseRef }) =>
        watchChecks({
          octokit,
          owner,
          repo,
          ref: headSha,
          deadlineMs: PROBE_DEADLINE_MS,
          settleMs: 0,
          requiredChecks: { branch: baseRef },
          probeNoCi: true,
        }),
      markReady: (nodeId) => markPullRequestReady(octokit, nodeId),
      // Land the draft's own branch, synced with main so a conflict takes the land conflict path (#1887 is out of
      // scope), and held rather than polled when a human gate label is set.
      land: (issue, branch) =>
        waitMerge(issue, branch, opts.repoRoot ?? process.cwd(), ghRepo, paths, {
          landBranch: branch,
          holdWhenGated: true,
          syncMain: true,
          ...(autoMerge === undefined ? {} : { mergeOverrides: { auto: autoMerge } }),
        }),
      queueRework: (issue, pr) =>
        queueCiPendingRework({
          store: createFileIterateStore(paths.iterate),
          queue: createOctokitQueueClient(octokit),
          owner,
          repo,
          issue,
          pr,
        }),
      log,
    });
    const acted = results.filter((r) => r.action !== 'still-pending' && r.action !== 'skipped');
    if (acted.length > 0) {
      console.log(
        `factory: CI-pending draft sweep handled ${acted.map((r) => `PR #${r.pr} (${r.action})`).join(', ')}`,
      );
    }
  } catch (err) {
    log('warn', 0, `CI-pending draft sweep failed: ${errorMessage(err)}`);
  }
}
