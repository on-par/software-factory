// src/phases/ship-ready.ts — mark a SHIP pull request ready for review, with one retry (#3551)

import type { Octokit } from '@octokit/rest';

import { shortDetail } from './ship-git.js';

/** Marks a PR ready for review, retrying once; a PR that is already not a draft is left as is. */
export async function markPrReadyWithRetry(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<{ ok: true; wasDraft: boolean } | { ok: false; detail: string }> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
      if (!pr.draft) return { ok: true, wasDraft: false };
      await octokit.graphql(
        `mutation MarkPullRequestReady($id: ID!) {
          markPullRequestReadyForReview(input: { pullRequestId: $id }) {
            pullRequest { isDraft }
          }
        }`,
        { id: pr.node_id },
      );
      return { ok: true, wasDraft: true };
    } catch (err) {
      lastErr = err;
    }
  }
  return { ok: false, detail: shortDetail(lastErr) };
}
