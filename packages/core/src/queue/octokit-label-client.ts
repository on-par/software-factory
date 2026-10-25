// packages/core/src/queue/octokit-label-client.ts — Octokit repo-label reads/deletes behind the lease-label cleanup (#1623).

import type { Octokit } from '@octokit/rest';

import { notFoundError } from './github-errors.js';
import type { QueueGitHubClient, QueueIssue } from './github-queue.js';
import { forgetRepoLabel } from './label-cache.js';

/** Pages (100 each) read by the full-list calls; past this they throw rather than return a partial list. */
export const REPO_LABEL_SWEEP_MAX_PAGES = 100;

type RawIssue = { number: number; title?: string; labels: Array<string | { name?: string }> };

/** Maps an Octokit issue to a QueueIssue, normalising string/object labels and dropping empty names. */
export function toQueueIssue(issue: RawIssue): QueueIssue {
  return {
    number: issue.number,
    labels: (issue.labels ?? [])
      .map((label) => (typeof label === 'string' ? label : (label.name ?? '')))
      .filter((name) => name !== ''),
    ...(typeof issue.title === 'string' ? { title: issue.title } : {}),
  };
}

export function createOctokitLabelSweepMethods(
  octokit: Octokit,
): Required<Pick<QueueGitHubClient, 'listRepoLabels' | 'deleteRepoLabel' | 'listAllOpenIssues'>> {
  return {
    async listRepoLabels({ owner, repo }) {
      const names: string[] = [];
      for (let page = 1; page <= REPO_LABEL_SWEEP_MAX_PAGES; page++) {
        const { data } = await octokit.rest.issues.listLabelsForRepo({ owner, repo, per_page: 100, page });
        for (const label of data) names.push(label.name);
        if (data.length < 100) return names;
      }
      throw new Error(`label list exceeded ${REPO_LABEL_SWEEP_MAX_PAGES} pages`);
    },
    async listAllOpenIssues({ owner, repo }) {
      const issues: QueueIssue[] = [];
      for (let page = 1; page <= REPO_LABEL_SWEEP_MAX_PAGES; page++) {
        const { data } = await octokit.rest.issues.listForRepo({ owner, repo, state: 'open', per_page: 100, page });
        for (const issue of data) issues.push(toQueueIssue(issue));
        if (data.length < 100) return issues;
      }
      throw new Error(`open issue list exceeded ${REPO_LABEL_SWEEP_MAX_PAGES} pages`);
    },
    async deleteRepoLabel({ owner, repo, name }) {
      try {
        await octokit.rest.issues.deleteLabel({ owner, repo, name });
      } catch (err) {
        if (!notFoundError(err)) throw err;
      }
      await forgetRepoLabel(octokit, owner, repo, name);
    },
  };
}

/** Best-effort: deletes the repo label a heartbeat just replaced, unless another open issue still carries it. */
export async function dropReplacedRepoLabel(
  client: QueueGitHubClient,
  owner: string,
  repo: string,
  name: string,
  issue: number,
): Promise<void> {
  if (!client.deleteRepoLabel) return;
  try {
    const holders = await client.listOpenIssuesWithLabels({ owner, repo, labels: [name] });
    if (holders.some((h) => h.number !== issue)) return; // same-second lease shared by another claim
    await client.deleteRepoLabel({ owner, repo, name });
  } catch {
    // The reaper's orphan sweep retries leftovers (#1623).
  }
}
