// packages/cli/src/cli/run-until-done-wiring.ts — production deps for `factory run --issue <n>`: GitHub lookups, ship, merge, feedback rounds and PR run state (#3908)

import type { Octokit } from '@octokit/rest';
import { workKeyFromIssue, type FactoryConfig, type getFactoryPaths, type RunOutcome } from '@on-par/factory-core';
import {
  collectFeedbackItems,
  createOctokitCollaboratorPermissionClient,
  createOctokitFeedbackRoundGitHub,
  factoryBranchIssue,
  isTrustedApprover,
  loadPrRunState,
  logEvent,
  MAX_REWORK_ROUNDS,
  reconcilePrRunState,
  resolveMaxReviewReworkRuns,
  savePrRunState,
  type PrRunState,
} from '@on-par/factory-core/internal';

import { CliExitError } from './errors.js';
import { respondDepsFrom, runFeedbackRound, type FeedbackRoundResult } from './respond-command.js';
import { driveToMerge, type MergeResult } from './run-issue-merge.js';
import type { IssuePr, UntilDoneDeps } from './run-until-done.js';
import { shipRuntime } from './ship-runtime.js';
import { localPrRunState, restorePrRunStateForRun } from './ship-pr-state.js';
import { shipIssue } from './ship.js';

/** The slice of a GitHub pull request this wiring reads. */
export interface PullSummary {
  number: number;
  state: string;
  merged_at: string | null;
  head: { ref: string; repo: { full_name: string } | null };
}

/** The two pull-request reads the lifecycle makes; the production port is bound to octokit. */
export interface PullsPort {
  list(page: number): Promise<PullSummary[]>;
  get(prNumber: number): Promise<PullSummary>;
}

const LIST_PAGE_SIZE = 100;

function pullState(pull: Pick<PullSummary, 'state' | 'merged_at'>): IssuePr['state'] {
  if (pull.merged_at) return 'merged';
  return pull.state === 'open' ? 'open' : 'closed';
}

/** The newest factory PR of `issue` from this repo: an open one first, else the newest merged or closed one. */
export async function findFactoryPr(
  pulls: PullsPort,
  repo: string,
  branchPrefix: string,
  issue: number,
): Promise<IssuePr | undefined> {
  let best: PullSummary | undefined;
  for (let page = 1; ; page++) {
    const batch = await pulls.list(page);
    for (const pr of batch) {
      if (factoryBranchIssue(pr.head.ref, branchPrefix) !== issue || pr.head.repo?.full_name !== repo) continue;
      const rank = (p: PullSummary): number => (pullState(p) === 'open' ? 1 : 0);
      const better =
        best === undefined || rank(pr) > rank(best) || (rank(pr) === rank(best) && pr.number > best.number);
      if (better) best = pr;
    }
    if (batch.length < LIST_PAGE_SIZE) break;
  }
  return best ? { number: best.number, branch: best.head.ref, state: pullState(best) } : undefined;
}

function pullsPortFrom(octokit: Octokit, repo: string): PullsPort {
  const [owner = '', name = ''] = repo.split('/');
  return {
    list: async (page) =>
      (await octokit.rest.pulls.list({ owner, repo: name, state: 'all', per_page: LIST_PAGE_SIZE, page })).data,
    get: async (pull_number) => (await octokit.rest.pulls.get({ owner, repo: name, pull_number })).data,
  };
}

/** The run state `awaiting-review` is saved with: the local and PR-held state reconciled, else a minimal one. */
export function awaitingReviewState(
  reconciled: PrRunState | null,
  issue: number,
  prNumber: number,
  cap: number,
  updatedAt: string,
): PrRunState {
  const base: PrRunState = reconciled ?? {
    version: 1,
    key: workKeyFromIssue(issue),
    prNumber,
    status: 'awaiting-review',
    spec: { sha256: '', summary: '' },
    checkRework: { used: 0, cap: MAX_REWORK_ROUNDS },
    reviewRework: { used: 0, cap },
    handledReviewIds: [],
    handledCommentIds: [],
    rounds: [],
    updatedAt,
  };
  const { draftReason: _stale, ...rest } = base;
  return { ...rest, status: 'awaiting-review', updatedAt };
}

export interface UntilDoneWiring {
  issue: number;
  octokit: Octokit;
  repo: string;
  repoRoot: string;
  paths: ReturnType<typeof getFactoryPaths>;
  config: FactoryConfig;
  branchPrefix: string;
  admin: boolean;
  mergeTimeoutMs: number;
  /** Receives every RunOutcome the ship pipeline reports. */
  onOutcome: (outcome: RunOutcome) => void;
  recordMerge: (result: MergeResult) => void;
  log: (line: string) => void;
}

/** Seams for tests; production uses the real ship, merge and feedback round. */
export interface UntilDonePorts {
  pulls?: PullsPort;
  ship?: typeof shipIssue;
  driveToMerge?: typeof driveToMerge;
  feedbackRound?: (prNumber: number) => Promise<FeedbackRoundResult>;
  restore?: typeof restorePrRunStateForRun;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
}

/** Builds the production UntilDoneDeps. */
export function untilDoneDepsFrom(w: UntilDoneWiring, ports: UntilDonePorts = {}): UntilDoneDeps {
  const { octokit, repo, paths, config } = w;
  const [owner = '', name = ''] = repo.split('/');
  const pulls = ports.pulls ?? pullsPortFrom(octokit, repo);
  const ship = ports.ship ?? shipIssue;
  const drive = ports.driveToMerge ?? driveToMerge;
  const restore = ports.restore ?? restorePrRunStateForRun;
  const round = ports.feedbackRound ?? ((prNumber) => runFeedbackRound(prNumber, respondDepsFrom(shipRuntime())));
  const cap = resolveMaxReviewReworkRuns(config);

  return {
    findIssuePr: (issue) => findFactoryPr(pulls, repo, w.branchPrefix, issue),
    prState: async (prNumber) => pullState(await pulls.get(prNumber)),
    ship: async (issue) => {
      let last: RunOutcome | undefined;
      try {
        await ship(
          issue,
          { branchPrefix: w.branchPrefix, autoRework: true, interactive: false },
          {
            repoRoot: w.repoRoot,
            ghRepo: repo,
            onOutcome: (o) => {
              last = o;
              w.onOutcome(o);
            },
          },
        );
      } catch (err) {
        if (err instanceof CliExitError || err instanceof shipRuntime().IssueSkippedError) throw err;
        w.log(`ship failed for issue #${issue}: ${err instanceof Error ? err.message : String(err)}`);
      }
      return last;
    },
    driveToMerge: async (outcome) => {
      const result = await drive({
        issue: w.issue,
        outcome,
        repoRoot: w.repoRoot,
        ghRepo: repo,
        paths,
        timeoutMs: w.mergeTimeoutMs,
        ...(w.admin ? { admin: true } : {}),
      });
      w.recordMerge(result);
      return result;
    },
    restorePrState: async (issue, branch) => {
      await restore({
        octokit,
        repo,
        branch,
        issueNum: issue,
        reviewReworkFile: paths.reviewRework,
        runsDir: paths.runs,
        maxReviewReworkRuns: cap,
        log: (kind, msg) => logEvent(paths.events, kind, issue, msg),
      });
    },
    pendingFeedback: async (prNumber) => {
      const client = createOctokitCollaboratorPermissionClient(octokit);
      const items = await collectFeedbackItems({
        github: createOctokitFeedbackRoundGitHub(octokit, owner, name),
        prNumber,
        isTrusted: (login) =>
          isTrustedApprover(login, { owner, repo: name, trustedApprovers: config.intake?.trustedApprovers, client }),
      });
      return items.length;
    },
    feedbackRound: async (prNumber) => {
      try {
        const r = await round(prNumber);
        return { parked: false, detail: r.result };
      } catch (err) {
        if (err instanceof CliExitError) return { parked: true, detail: err.message };
        throw err;
      }
    },
    saveAwaitingReview: async (issue, prNumber) => {
      try {
        const key = workKeyFromIssue(issue);
        const loaded = await loadPrRunState({ octokit, repo, prNumber, key });
        const local = await localPrRunState({
          issueNum: issue,
          prNumber,
          runsDir: paths.runs,
          reviewReworkFile: paths.reviewRework,
          maxReviewReworkRuns: cap,
        });
        const remote = loaded.status === 'found' ? loaded.state : null;
        const state = awaitingReviewState(
          reconcilePrRunState(local, remote),
          issue,
          prNumber,
          cap,
          new Date().toISOString(),
        );
        await savePrRunState({ octokit, repo, prNumber, state });
      } catch (err) {
        logEvent(
          paths.events,
          'pr_state_failed',
          issue,
          `could not save awaiting-review run state to PR #${prNumber}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
    now: () => Date.now(),
    sleep: ports.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
    pollMs: ports.pollMs ?? 60_000,
    log: w.log,
  };
}
