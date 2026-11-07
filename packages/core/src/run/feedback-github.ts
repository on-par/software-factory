// packages/core/src/run/feedback-github.ts — the GitHub port a feedback round reads feedback from and answers through (#3910)
import type { Octokit } from '@octokit/rest';

import { resolveSelfIdentity } from '../utils/github-identity.js';

export interface FeedbackPull {
  state: string;
  headRef: string;
  author: string;
  body: string;
}

export interface FeedbackReview {
  id: number;
  login: string;
  state: string;
  body: string;
  htmlUrl: string;
}

export interface FeedbackReviewComment {
  id: number;
  reviewId: number;
  inReplyTo?: number;
  login: string;
  path: string;
  line?: number;
  body: string;
  htmlUrl: string;
}

export interface FeedbackIssueComment {
  id: number;
  login: string;
  body: string;
  htmlUrl: string;
}

export interface FeedbackReviewThread {
  threadId: string;
  isResolved: boolean;
  commentIds: number[];
}

export interface FeedbackRoundGitHub {
  getPull(pr: number): Promise<FeedbackPull>;
  listReviews(pr: number): Promise<FeedbackReview[]>;
  listReviewComments(pr: number): Promise<FeedbackReviewComment[]>;
  listIssueComments(pr: number): Promise<FeedbackIssueComment[]>;
  listReviewThreads(pr: number): Promise<FeedbackReviewThread[]>;
  viewerLogin(): Promise<string>;
  replyToReviewComment(pr: number, commentId: number, body: string): Promise<void>;
  postIssueComment(pr: number, body: string): Promise<void>;
  resolveThread(threadId: string): Promise<void>;
  requestReviewers(pr: number, logins: readonly string[]): Promise<void>;
  updatePullBody(pr: number, body: string): Promise<void>;
}

const THREADS_QUERY = `query($owner: String!, $repo: String!, $pr: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      reviewThreads(first: 100) {
        nodes { id isResolved comments(first: 100) { nodes { databaseId } } }
      }
    }
  }
}`;

const RESOLVE_MUTATION = `mutation($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) { thread { id isResolved } }
}`;

interface ThreadsResponse {
  repository?: {
    pullRequest?: {
      reviewThreads?: {
        nodes?: { id: string; isResolved: boolean; comments?: { nodes?: { databaseId: number | null }[] } }[];
      };
    };
  };
}

export function createOctokitFeedbackRoundGitHub(octokit: Octokit, owner: string, repo: string): FeedbackRoundGitHub {
  const base = (pr: number) => ({ owner, repo, pull_number: pr });
  return {
    async getPull(pr) {
      const { data } = await octokit.rest.pulls.get(base(pr));
      return { state: data.state, headRef: data.head.ref, author: data.user?.login ?? '', body: data.body ?? '' };
    },
    async listReviews(pr) {
      const rows = await octokit.paginate(octokit.rest.pulls.listReviews, { ...base(pr), per_page: 100 });
      return rows.map((r) => ({
        id: r.id,
        login: r.user?.login ?? '',
        state: r.state,
        body: r.body ?? '',
        htmlUrl: r.html_url,
      }));
    },
    async listReviewComments(pr) {
      const rows = await octokit.paginate(octokit.rest.pulls.listReviewComments, { ...base(pr), per_page: 100 });
      return rows.map((c) => ({
        id: c.id,
        reviewId: c.pull_request_review_id ?? 0,
        ...(c.in_reply_to_id === undefined ? {} : { inReplyTo: c.in_reply_to_id }),
        login: c.user?.login ?? '',
        path: c.path,
        ...((c.line ?? c.original_line) == null ? {} : { line: c.line ?? c.original_line ?? undefined }),
        body: c.body,
        htmlUrl: c.html_url,
      }));
    },
    async listIssueComments(pr) {
      const rows = await octokit.paginate(octokit.rest.issues.listComments, {
        owner,
        repo,
        issue_number: pr,
        per_page: 100,
      });
      return rows.map((c) => ({ id: c.id, login: c.user?.login ?? '', body: c.body ?? '', htmlUrl: c.html_url }));
    },
    async listReviewThreads(pr) {
      const res = await octokit.graphql<ThreadsResponse>(THREADS_QUERY, { owner, repo, pr });
      const nodes = res.repository?.pullRequest?.reviewThreads?.nodes ?? [];
      return nodes.map((t) => ({
        threadId: t.id,
        isResolved: t.isResolved,
        commentIds: (t.comments?.nodes ?? []).flatMap((c) => (typeof c.databaseId === 'number' ? [c.databaseId] : [])),
      }));
    },
    async viewerLogin() {
      return (await resolveSelfIdentity(octokit)).login;
    },
    async replyToReviewComment(pr, commentId, body) {
      await octokit.rest.pulls.createReplyForReviewComment({ ...base(pr), comment_id: commentId, body });
    },
    async postIssueComment(pr, body) {
      await octokit.rest.issues.createComment({ owner, repo, issue_number: pr, body });
    },
    async resolveThread(threadId) {
      await octokit.graphql(RESOLVE_MUTATION, { threadId });
    },
    async requestReviewers(pr, logins) {
      const { data } = await octokit.rest.pulls.get(base(pr));
      const author = (data.user?.login ?? '').toLowerCase();
      const reviewers = logins.filter((l) => l.toLowerCase() !== author);
      if (reviewers.length === 0) return;
      await octokit.rest.pulls.requestReviewers({ ...base(pr), reviewers });
    },
    async updatePullBody(pr, body) {
      await octokit.rest.pulls.update({ ...base(pr), body });
    },
  };
}
