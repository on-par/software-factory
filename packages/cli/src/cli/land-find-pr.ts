// packages/cli/src/cli/land-find-pr.ts — open-PR lookup by `Closes #N` body, split out of land.ts (#3905)

import type { Octokit } from '@octokit/rest';
import type { OpenPullRequestEvidence } from './index.js';

/** queue-preflight only (it must see fork PRs to park them); land uses the core lookup (#3439). */
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
      return {
        number: pr.number,
        branch: pr.head.ref,
        headSha: pr.head.sha,
        headRepoFullName: pr.head.repo?.full_name ?? null,
      };
    }
    if (prs.length < perPage) return undefined;
  }
}
