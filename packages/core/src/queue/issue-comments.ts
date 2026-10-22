// packages/core/src/queue/issue-comments.ts — issue-comment primitives of the queue client, for claim markers (#3238).

import type { Octokit } from '@octokit/rest';

import { notFoundError } from './github-errors.js';

/** One issue comment as the queue sees it. `id` is GitHub's server-assigned, monotonically increasing comment id. */
export interface QueueIssueComment {
  id: number;
  body: string;
  createdAt: string;
}

export interface QueueCommentClient {
  /** Post a comment on an issue. Resolves the new comment's id. */
  createIssueComment(input: {
    owner: string;
    repo: string;
    issue_number: number;
    body: string;
  }): Promise<{ id: number }>;
  /** Every comment on an issue, across all pages, in ascending id order. */
  listIssueComments(input: { owner: string; repo: string; issue_number: number }): Promise<QueueIssueComment[]>;
  /** Delete a comment. A comment that is already gone (404) is not an error. */
  deleteIssueComment(input: { owner: string; repo: string; comment_id: number }): Promise<void>;
}

export function createOctokitComments(octokit: Octokit): QueueCommentClient {
  return {
    async createIssueComment({ owner, repo, issue_number, body }) {
      const { data } = await octokit.rest.issues.createComment({ owner, repo, issue_number, body });
      return { id: data.id };
    },
    async listIssueComments({ owner, repo, issue_number }) {
      const data = await octokit.paginate(octokit.rest.issues.listComments, {
        owner,
        repo,
        issue_number,
        per_page: 100,
      });
      return data.map((c) => ({ id: c.id, body: c.body ?? '', createdAt: c.created_at })).sort((a, b) => a.id - b.id);
    },
    async deleteIssueComment({ owner, repo, comment_id }) {
      try {
        await octokit.rest.issues.deleteComment({ owner, repo, comment_id });
      } catch (err) {
        if (!notFoundError(err)) throw err; // 404: already deleted
      }
    },
  };
}
