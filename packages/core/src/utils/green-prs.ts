import type { Octokit } from '@octokit/rest';

import { isPassingConclusion } from './ci-watch.js';

export interface OpenPullRequestSummary {
  number: number;
  branch: string;
  headSha: string;
  title: string;
  body: string | null;
  draft: boolean;
  createdAt: string;
}

export interface GreenPrGitHubClient {
  listOpenPullRequests(args: { owner: string; repo: string }): Promise<OpenPullRequestSummary[]>;
  listCheckRuns(args: {
    owner: string;
    repo: string;
    ref: string;
  }): Promise<Array<{ status: string | null; conclusion: string | null }>>;
}

export interface UnmergedGreenPr {
  number: number;
  branch: string;
  title: string;
  issue: number | null;
  ageHours: number;
}

export interface FindUnmergedGreenPrsOptions {
  client: GreenPrGitHubClient;
  owner: string;
  repo: string;
  now?: () => number;
}

const CLOSING_KEYWORD = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/i;
const BRANCH_ISSUE = /^[^/]+\/(\d+)-/;
const MS_PER_HOUR = 3_600_000;

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
    const ageHours = Number.isNaN(createdAtMs) ? 0 : Math.max(0, Math.floor((now() - createdAtMs) / MS_PER_HOUR));

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
