// packages/cli/src/cli/respond-command.ts — `factory respond <pr>`: run a feedback round on a factory PR (#3910)

import type { Octokit } from '@octokit/rest';
import { getFactoryPaths, workKeyFromIssue, type FactoryConfig } from '@on-par/factory-core';
import {
  countReviewReworkRuns,
  createFileReviewReworkStore,
  createOctokitQueueClient,
  factoryBranchIssue,
  LANE_LABEL_PREFIX,
  parkAtReviewReworkCap,
  publishParkComment,
  resolveBranchPrefix,
  resolveMaxReviewReworkRuns,
} from '@on-par/factory-core/internal';

import { CliExitError } from './errors.js';
import { withRepoRunLock } from './repo-run-lock.js';
import { shipRuntime } from './ship-runtime.js';
import { shipIssue } from './ship.js';

export interface RespondDeps {
  getRepoRoot: () => Promise<string>;
  getGitHubRepo: () => Promise<string>;
  getOctokit: () => Octokit;
  loadConfig: (configPath: string) => FactoryConfig;
  shipIssue: (
    issue: number,
    opts: { branchPrefix: string; autoRework: boolean; interactive: boolean },
    ctx: { repoRoot: string; ghRepo: string; feedbackRound: { prNumber: number } },
  ) => Promise<string>;
  /** Parks the issue at the review-rework cap with one comment. */
  parkAtCap: typeof parkAtReviewReworkCap;
  publishParkComment: typeof publishParkComment;
  now: () => Date;
  out: (line: string) => void;
}

/** The slice of the ship runtime that respond's production deps are wired from. */
export interface RespondRuntime<Shell> {
  resolveShellOps: (overrides: Record<string, never>) => Shell;
  getRepoRoot: (shell: Shell) => Promise<string>;
  getGitHubRepo: (shell: Shell) => Promise<string>;
  getOctokit: (shell: Shell) => Octokit;
  resolveConfigLoaders: (overrides: Record<string, never>) => {
    loadFactoryConfigForRepo: (configPath: string) => FactoryConfig;
  };
}

/** The production deps, wired from the ship runtime. */
export function respondDepsFrom<Shell>(runtime: RespondRuntime<Shell>): RespondDeps {
  const shell = runtime.resolveShellOps({});
  return {
    getRepoRoot: () => runtime.getRepoRoot(shell),
    getGitHubRepo: () => runtime.getGitHubRepo(shell),
    getOctokit: () => runtime.getOctokit(shell),
    loadConfig: (configPath) => runtime.resolveConfigLoaders({}).loadFactoryConfigForRepo(configPath),
    shipIssue,
    parkAtCap: parkAtReviewReworkCap,
    publishParkComment,
    now: () => new Date(),
    out: console.log,
  };
}

export type RespondToPrResult =
  { issue: number; result: string } | { parked: true; issue: number; count: number; cap: number };

/**
 * One feedback round on the open factory PR `prNumber`, or a park at the review-rework cap. `ctx.minUsed` lifts the
 * cap count above the local store's (a fresh clone has an empty store); `ctx.lock: false` is for a caller that
 * already holds the repo run lock (#3908).
 */
export async function respondToPr(
  prNumber: number,
  deps: RespondDeps,
  ctx: { minUsed?: number; lock?: boolean } = {},
): Promise<RespondToPrResult> {
  const repoRoot = await deps.getRepoRoot();
  const ghRepo = await deps.getGitHubRepo();
  const [owner = '', repo = ''] = ghRepo.split('/');
  const paths = getFactoryPaths(repoRoot);
  const config = deps.loadConfig(paths.config);
  const prefix = resolveBranchPrefix(config);
  const octokit = deps.getOctokit();

  const { data: pull } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
  if (pull.state !== 'open') {
    throw new CliExitError(
      `factory respond: PR #${prNumber} is ${pull.state}; only an open factory PR takes a round`,
      1,
    );
  }
  const issue = factoryBranchIssue(pull.head.ref, prefix);
  if (issue === null || pull.head.repo?.full_name !== ghRepo) {
    throw new CliExitError(`factory respond: PR #${prNumber} (${pull.head.ref}) is not a factory PR of ${ghRepo}`, 1);
  }

  const store = createFileReviewReworkStore(paths.reviewRework);
  const key = workKeyFromIssue(issue);
  const cap = resolveMaxReviewReworkRuns(config);
  const count = Math.max(countReviewReworkRuns(store, key), ctx.minUsed ?? 0);
  const earlier = store.list().filter((r) => r.source === 'feedback' && r.issue === issue).length;
  const reviewId = prNumber * 10_000 + earlier + 1;
  const queue = createOctokitQueueClient(octokit);
  const labels = await queue.getIssueLabels({ owner, repo, issue_number: issue });
  const lane = labels.find((l) => l.startsWith(LANE_LABEL_PREFIX))?.slice(LANE_LABEL_PREFIX.length) ?? '';
  const at = deps.now().toISOString();
  if (count >= cap) {
    await deps.parkAtCap({
      queue,
      owner,
      repo,
      issue: key,
      pr: prNumber,
      lane,
      branch: pull.head.ref,
      cap,
      count,
      reviewIds: [reviewId],
      source: 'feedback',
      publishComment: (input) => deps.publishParkComment({ octokit, repo: ghRepo, input }),
    });
    return { parked: true, issue, count, cap };
  }
  store.record({ reviewId, source: 'feedback', pr: prNumber, issue, lane, reviewer: '', queuedAt: at, startedAt: at });

  const ship = () =>
    deps.shipIssue(
      issue,
      { branchPrefix: prefix, autoRework: true, interactive: false },
      { repoRoot, ghRepo, feedbackRound: { prNumber } },
    );
  const result = ctx.lock === false ? await ship() : await withRepoRunLock(paths, 'factory respond', ship);
  return { issue, result };
}

/** Run a feedback round on the factory PR `pr`: triage new trusted feedback, re-plan or rework, push, reply, resolve fixed threads and re-request review. */
export async function cmdRespond(
  pr: string,
  opts: { json?: boolean },
  deps: RespondDeps = respondDepsFrom(shipRuntime()),
): Promise<void> {
  if (!/^#?\d+$/.test(pr.trim())) throw new CliExitError(`factory respond: '${pr}' is not a pull request number`, 2);
  const prNumber = Number(pr.trim().replace('#', ''));
  const round = await respondToPr(prNumber, deps);
  if ('parked' in round) {
    throw new CliExitError(
      `factory respond: #${round.issue} is parked at the review-rework cap (${round.count} of ${round.cap}); resolve by hand, then run \`factory unpark ${round.issue}\``,
      1,
    );
  }
  const { issue, result } = round;
  deps.out(
    opts.json
      ? JSON.stringify({ pr: prNumber, issue, result })
      : `feedback round on PR #${prNumber} (issue #${issue}): ${result}`,
  );
}
