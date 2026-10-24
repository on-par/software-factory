// packages/core/src/queue/list-issues-paged.ts — every open issue carrying all `labels`, across pages, PRs dropped (#3147).

import type { Octokit } from '@octokit/rest';

import type { QueueIssue } from './github-queue.js';

const PER_PAGE = 100;

/** Hand-rolled page loop (not octokit.paginate) so `rest`-only fakes keep working. Stops on a short raw page. */
export async function listIssuesPaged(
  octokit: Octokit,
  input: { owner: string; repo: string; labels: readonly string[] },
): Promise<QueueIssue[]> {
  const out: QueueIssue[] = [];
  for (let page = 1; ; page += 1) {
    const { data } = await octokit.rest.issues.listForRepo({
      owner: input.owner,
      repo: input.repo,
      state: 'open',
      labels: input.labels.join(','),
      per_page: PER_PAGE,
      page,
    });
    for (const issue of data) {
      if (issue.pull_request) continue;
      out.push({
        number: issue.number,
        labels: (issue.labels ?? [])
          .map((label) => (typeof label === 'string' ? label : (label.name ?? '')))
          .filter((name) => name !== ''),
        ...(typeof issue.title === 'string' ? { title: issue.title } : {}),
      });
    }
    if (data.length < PER_PAGE) return out;
  }
}
