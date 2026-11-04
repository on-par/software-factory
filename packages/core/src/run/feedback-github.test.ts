import type { Octokit } from '@octokit/rest';
import { describe, expect, it } from 'vitest';

import { asPhaseOctokit, createSimOctokit, type SimOctokitEndpoint, type SimOctokitStep } from '../fakes/octokit.js';
import { createOctokitFeedbackRoundGitHub } from './feedback-github.js';

function setup(endpoints: Partial<Record<SimOctokitEndpoint, SimOctokitStep[]>> = {}) {
  const { octokit, calls } = createSimOctokit({ endpoints });
  const github = createOctokitFeedbackRoundGitHub(asPhaseOctokit(octokit) as Octokit, 'o', 'r');
  return { github, calls };
}

describe('createOctokitFeedbackRoundGitHub', () => {
  it('maps the pull, reviews, review comments and issue comments', async () => {
    const { github } = setup({
      'pulls.get': [
        { response: { data: { state: 'open', head: { ref: 'factory/7-x' }, user: { login: 'bot' }, body: 'desc' } } },
      ],
      'pulls.listReviews': [
        { response: { data: [{ id: 1, user: { login: 'amy' }, state: 'COMMENTED', body: 'hi', html_url: 'u1' }] } },
      ],
      'pulls.listReviewComments': [
        {
          response: {
            data: [
              {
                id: 2,
                pull_request_review_id: 1,
                user: { login: 'amy' },
                path: 'a.ts',
                line: 3,
                body: 'b',
                html_url: 'u2',
              },
              {
                id: 3,
                pull_request_review_id: 1,
                in_reply_to_id: 2,
                user: null,
                path: 'a.ts',
                body: 'c',
                html_url: 'u3',
              },
            ],
          },
        },
      ],
      'issues.listComments': [{ response: { data: [{ id: 4, user: { login: 'bo' }, body: null, html_url: 'u4' }] } }],
    });
    expect(await github.getPull(7)).toEqual({ state: 'open', headRef: 'factory/7-x', author: 'bot', body: 'desc' });
    expect(await github.listReviews(7)).toEqual([
      { id: 1, login: 'amy', state: 'COMMENTED', body: 'hi', htmlUrl: 'u1' },
    ]);
    expect(await github.listReviewComments(7)).toEqual([
      { id: 2, reviewId: 1, login: 'amy', path: 'a.ts', line: 3, body: 'b', htmlUrl: 'u2' },
      { id: 3, reviewId: 1, inReplyTo: 2, login: '', path: 'a.ts', body: 'c', htmlUrl: 'u3' },
    ]);
    expect(await github.listIssueComments(7)).toEqual([{ id: 4, login: 'bo', body: '', htmlUrl: 'u4' }]);
  });

  it('lists review threads over GraphQL and resolves one', async () => {
    const { github, calls } = setup({
      graphql: [
        {
          response: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [
                    { id: 'T1', isResolved: false, comments: { nodes: [{ databaseId: 2 }, { databaseId: null }] } },
                  ],
                },
              },
            },
          },
        },
      ],
    });
    expect(await github.listReviewThreads(7)).toEqual([{ threadId: 'T1', isResolved: false, commentIds: [2] }]);
    await github.resolveThread('T1');
    const [list, resolve] = calls.filter((c) => c[0] === 'graphql');
    expect(String(list?.[1])).toContain('reviewThreads(first: 100)');
    expect(String(resolve?.[1])).toContain('resolveReviewThread');
    expect(resolve?.[2]).toEqual({ threadId: 'T1' });
  });

  it('reads the viewer and writes replies, comments and the PR body', async () => {
    const { github, calls } = setup();
    expect(await github.viewerLogin()).toBe('factory-bot');
    await github.replyToReviewComment(7, 2, 'r');
    await github.postIssueComment(7, 'c');
    await github.updatePullBody(7, 'new');
    expect(calls).toContainEqual([
      'pulls.createReplyForReviewComment',
      { owner: 'o', repo: 'r', pull_number: 7, comment_id: 2, body: 'r' },
    ]);
    expect(calls).toContainEqual(['issues.createComment', { owner: 'o', repo: 'r', issue_number: 7, body: 'c' }]);
    expect(calls).toContainEqual(['pulls.update', { owner: 'o', repo: 'r', pull_number: 7, body: 'new' }]);
  });

  it('requestReviewers filters out the PR author and skips the call when none remain', async () => {
    const author = { response: { data: { user: { login: 'Bot' } } } };
    const { github, calls } = setup({ 'pulls.get': [author, author] });
    await github.requestReviewers(7, ['bot', 'amy']);
    await github.requestReviewers(7, ['BOT']);
    const requests = calls.filter((c) => c[0] === 'pulls.requestReviewers');
    expect(requests).toEqual([
      ['pulls.requestReviewers', { owner: 'o', repo: 'r', pull_number: 7, reviewers: ['amy'] }],
    ]);
  });
});
