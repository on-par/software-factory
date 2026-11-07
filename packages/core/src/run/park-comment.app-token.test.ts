// packages/core/src/run/park-comment.app-token.test.ts — own marker comments under a GitHub App installation token
import type { Octokit } from '@octokit/rest';
import { describe, expect, it, vi } from 'vitest';

import { workKeyFromIssue } from '../work/work-key.js';
import { findOwnParkComment, issueStateMarker, upsertMarkerComment } from './park-comment.js';

const K7 = workKeyFromIssue(7);
const APP_BOT = 9001;
const appBot = { id: APP_BOT, login: 'factory-app[bot]', type: 'Bot' };
const otherBot = { id: 9002, login: 'other-app[bot]', type: 'Bot' };
const human = { id: 5, login: 'someone', type: 'User' };

type Author = { id: number; login: string; type: string };

function octokitFor(comments: { id: number; body: string; user: Author }[], token: 'user' | 'app') {
  const getAuthenticated =
    token === 'user'
      ? vi.fn(async () => ({ data: { id: human.id, login: human.login, type: 'User' } }))
      : vi.fn(async () => {
          throw Object.assign(new Error('Resource not accessible by integration'), { status: 403 });
        });
  const graphql = vi.fn(async () => ({ viewer: { __typename: 'Bot', login: 'factory-app', databaseId: APP_BOT } }));
  const listComments = vi.fn(async () => ({ data: comments }));
  const createComment = vi.fn(async () => ({ data: { id: 1000 } }));
  const updateComment = vi.fn(async () => ({ data: {} }));
  const octokit = Object.assign({} as Octokit, {
    graphql,
    rest: { users: { getAuthenticated }, issues: { listComments, createComment, updateComment } },
  });
  return { octokit, graphql, createComment, updateComment };
}

describe('park comments with a GitHub App installation token', () => {
  const marker = issueStateMarker(K7);

  it("finds only the App bot's own park comment, not another bot's or a human's", async () => {
    const f = octokitFor(
      [
        { id: 1, body: marker, user: otherBot },
        { id: 2, body: marker, user: human },
        { id: 3, body: marker, user: appBot },
      ],
      'app',
    );
    expect(await findOwnParkComment({ octokit: f.octokit, repo: 'o/r', issue: K7 })).toEqual({ id: 3, body: marker });
    expect(f.graphql).toHaveBeenCalledTimes(1);
  });

  it('creates a new comment instead of editing a marker comment by another bot', async () => {
    const f = octokitFor([{ id: 1, body: marker, user: otherBot }], 'app');
    const result = await upsertMarkerComment({ octokit: f.octokit, repo: 'o/r', issue: K7, marker, body: 'x' });
    expect(result).toEqual({ commentId: 1000, created: true });
    expect(f.updateComment).not.toHaveBeenCalled();
  });

  it('keeps user-token behaviour: REST identity, no GraphQL call', async () => {
    const f = octokitFor(
      [
        { id: 1, body: marker, user: appBot },
        { id: 2, body: marker, user: human },
      ],
      'user',
    );
    expect(await findOwnParkComment({ octokit: f.octokit, repo: 'o/r', issue: K7 })).toEqual({ id: 2, body: marker });
    expect(f.graphql).not.toHaveBeenCalled();
  });
});
