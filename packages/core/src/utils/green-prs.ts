// packages/core/src/utils/green-prs.ts — Report green-and-ready PRs with no merge (#1000).

import type { Octokit } from '@octokit/rest';

import { isPassingConclusion } from './ci-watch.js';

/** The fields the scan needs from one open pull request. */
export interface OpenPullRequestSummary {
  number: number;
  /** Head branch ref, e.g. `ship-it/939-fix-thing`. */
  branch: string;
  /** Head SHA — the ref the check runs are listed for. */
  headSha: string;
  title: string;
  body: string | null;
  draft: boolean;
  /** ISO-8601 creation timestamp, straight from GitHub. */
  createdAt: string;
}

/** Read-only GitHub surface the scan needs. Deliberately has no merge/close method: `factory
 *  doctor` reports these PRs, it never lands them (#1000 / #980 out of scope). */
export interface GreenPrGitHubClient {
  listOpenPullRequests(args: { owner: string; repo: string }): Promise<OpenPullRequestSummary[]>;
  listCheckRuns(args: {
    owner: string;
    repo: string;
    ref: string;
  }): Promise<Array<{ status: string | null; conclusion: string | null }>>;
}

/** One open, non-draft, fully-green pull request that nobody merged. */
export interface UnmergedGreenPr {
  number: number;
  branch: string;
  title: string;
  /** The issue this PR closes, or null when neither the body nor the branch names one. */
  issue: number | null;
  /** Whole hours the PR has been open, floored at 0. */
  ageHours: number;
}

export interface FindUnmergedGreenPrsOptions {
  client: GreenPrGitHubClient;
  owner: string;
  repo: string;
  /** Defaults to `() => Date.now()`. Injectable so tests can pin the age. */
  now?: () => number;
}

/** GitHub's own closing keywords; ship.ts writes `Closes #<issue>` into every factory PR body. */
const CLOSING_KEYWORD = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/i;
/** `branchFor()` mints `<prefix>/<issue>-<slug>` (utils/index.ts) — the fallback when the body
 *  carries no closing keyword (e.g. a `--inline-work` run, which omits the Closes line). */
const BRANCH_ISSUE = /^[^/]+\/(\d+)-/;

export function owningIssueForPr(pr: { body: string | null; branch: string }): number | null {
  const fromBody = CLOSING_KEYWORD.exec(pr.body ?? '');
  if (fromBody) return Number(fromBody[1]);
  const fromBranch = BRANCH_ISSUE.exec(pr.branch);
  return fromBranch ? Number(fromBranch[1]) : null;
}

export async function findUnmergedGreenPrs(opts: FindUnmergedGreenPrsOptions): Promise<UnmergedGreenPr[]> {
  const { client, owner, repo, now = () => Date.now() } = opts;
  const prs = await client.listOpenPullRequests({ owner, repo });
  const results: UnmergedGreenPr[] = [];

  for (const pr of prs) {
    if (pr.draft) continue;

    const runs = await client.listCheckRuns({ owner, repo, ref: pr.headSha });
    const isGreen =
      runs.length > 0 &&
      runs.every((r) => r.status === 'completed') &&
      runs.every((r) => isPassingConclusion(r.conclusion));
    if (!isGreen) continue;

    const createdAtMs = Date.parse(pr.createdAt);
    const ageHours = Number.isNaN(createdAtMs) ? 0 : Math.max(0, Math.floor((now() - createdAtMs) / 3_600_000));

    results.push({ number: pr.number, branch: pr.branch, title: pr.title, issue: owningIssueForPr(pr), ageHours });
  }

  return results;
}

export function createOctokitGreenPrClient(octokit: Octokit): GreenPrGitHubClient {
  return {
    async listOpenPullRequests({ owner, repo }) {
      const { data } = await octokit.rest.pulls.list({ owner, repo, state: 'open', per_page: 100 });
      return data.map((pr) => ({
        number: pr.number,
        branch: pr.head.ref,
        headSha: pr.head.sha,
        title: pr.title,
        body: pr.body ?? null,
        draft: pr.draft === true,
        createdAt: pr.created_at,
      }));
    },
    async listCheckRuns({ owner, repo, ref }) {
      const { data } = await octokit.rest.checks.listForRef({ owner, repo, ref, per_page: 100 });
      return (data.check_runs ?? []).map((run) => ({ status: run.status ?? null, conclusion: run.conclusion ?? null }));
    },
  };
}
