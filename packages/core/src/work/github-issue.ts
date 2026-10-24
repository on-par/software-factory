// packages/core/src/work/github-issue.ts — GitHub issue input-source adapter (#505).

import type { Octokit } from '@octokit/rest';

import { extractAcceptanceCriteria } from './acceptance.js';
import {
  InvalidWorkRequestInputError,
  type WorkRequest,
  type WorkRequestState,
  type WorkSourceAdapter,
} from './index.js';
import { workKeyFromIssue } from './work-key.js';

export const GITHUB_ISSUE_SOURCE = 'github-issue';

export interface GithubIssueParams {
  /** "owner/repo". */
  repo: string;
  issue: number;
}

export interface WorkIssueClient {
  fetchIssue(input: { owner: string; repo: string; issue_number: number }): Promise<{
    title: string;
    body: string | null;
    htmlUrl?: string;
    state?: WorkRequestState;
    /** True when the number belongs to a pull request (GitHub's issues API serves both). */
    isPullRequest?: boolean;
  }>;
}

/** The issue a pull request body says it closes, if any ("Closes #12", "fixes #12"). */
function linkedIssueFromPrBody(body: string | null): number | undefined {
  const m = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/i.exec(body ?? '');
  return m ? Number(m[1]) : undefined;
}

/** #2492: `ship`/`run-issue` got a pull request number. Raised before any model, worktree or plan call.
 *  A function (not a subclass) because work/index.ts imports this module (a class here would hit the cycle). */
function pullRequestNotIssueError(prNumber: number, linkedIssue: number | undefined): InvalidWorkRequestInputError {
  const err = new InvalidWorkRequestInputError(GITHUB_ISSUE_SOURCE, 'pull request number');
  err.message =
    `#${prNumber} is a pull request, not an issue.` +
    (linkedIssue === undefined ? ' Pass the issue number it closes.' : ` Did you mean issue #${linkedIssue}?`);
  return err;
}

export function createOctokitIssueClient(octokit: Octokit): WorkIssueClient {
  return {
    async fetchIssue({ owner, repo, issue_number }) {
      const { data } = await octokit.rest.issues.get({ owner, repo, issue_number });
      return {
        title: data.title,
        body: data.body ?? null,
        htmlUrl: data.html_url,
        state: data.state === 'closed' ? 'closed' : 'open',
        isPullRequest: data.pull_request != null,
      };
    },
  };
}

function isGithubIssueParams(params: unknown): params is GithubIssueParams {
  if (typeof params !== 'object' || params === null) return false;
  const { repo, issue } = params as { repo?: unknown; issue?: unknown };
  if (typeof repo !== 'string') return false;
  const slashIndex = repo.indexOf('/');
  if (slashIndex <= 0 || slashIndex === repo.length - 1) return false;
  if (typeof issue !== 'number' || !Number.isInteger(issue) || issue <= 0) return false;
  return true;
}

export function createGithubIssueAdapter(client: WorkIssueClient): WorkSourceAdapter {
  return {
    kind: GITHUB_ISSUE_SOURCE,
    async resolve(params: unknown): Promise<WorkRequest> {
      if (!isGithubIssueParams(params)) {
        throw new InvalidWorkRequestInputError(GITHUB_ISSUE_SOURCE, 'expected { repo: "owner/name", issue: number }');
      }

      const [owner, name] = params.repo.split('/');
      const data = await client.fetchIssue({ owner, repo: name, issue_number: params.issue });
      if (data.isPullRequest === true) {
        throw pullRequestNotIssueError(params.issue, linkedIssueFromPrBody(data.body));
      }
      const brief = data.body ?? '';

      return {
        id: `${GITHUB_ISSUE_SOURCE}:${params.repo}#${params.issue}`,
        key: workKeyFromIssue(params.issue),
        kind: GITHUB_ISSUE_SOURCE,
        title: data.title,
        brief,
        acceptanceCriteria: extractAcceptanceCriteria(brief),
        state: data.state,
        reference: {
          externalId: String(params.issue),
          repo: params.repo,
          url:
            data.htmlUrl && data.htmlUrl.length > 0
              ? data.htmlUrl
              : `https://github.com/${params.repo}/issues/${params.issue}`,
        },
      };
    },
  };
}
