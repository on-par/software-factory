// packages/core/src/work/github-issue.ts — GitHub issue input-source adapter (#505).

import type { Octokit } from '@octokit/rest';

import { extractAcceptanceCriteria } from './acceptance.js';
import {
  InvalidWorkRequestInputError,
  type WorkRequest,
  type WorkRequestState,
  type WorkSourceAdapter,
} from './index.js';

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
  }>;
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
      const brief = data.body ?? '';

      return {
        id: `${GITHUB_ISSUE_SOURCE}:${params.repo}#${params.issue}`,
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
