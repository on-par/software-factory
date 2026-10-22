// packages/core/src/queue/fake-issue-comments.ts — in-memory issue-comment methods for QueueGitHubClient test fakes (#3238).

import type { QueueCommentClient, QueueIssueComment } from './issue-comments.js';

/** Fresh comment store per call; ids increase per created comment. */
export function fakeIssueComments(): QueueCommentClient {
  const comments: Array<QueueIssueComment & { issue: number }> = [];
  let nextId = 1;
  return {
    async createIssueComment({ issue_number, body }) {
      const id = nextId++;
      comments.push({ id, issue: issue_number, body, createdAt: new Date(0).toISOString() });
      return { id };
    },
    async listIssueComments({ issue_number }) {
      return comments.filter((c) => c.issue === issue_number).map(({ issue: _issue, ...c }) => c);
    },
    async deleteIssueComment({ comment_id }) {
      const at = comments.findIndex((c) => c.id === comment_id);
      if (at >= 0) comments.splice(at, 1);
    },
  };
}
