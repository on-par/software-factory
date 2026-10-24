import type { Octokit } from '@octokit/rest';
import { vi } from 'vitest';

import { workKeyFromIssue } from '../work/work-key.js';
import type { ParkCommentInput } from './park-comment.js';

export const ME = 99;
export const K7 = workKeyFromIssue(7);

export function input(overrides: Partial<ParkCommentInput> = {}): ParkCommentInput {
  return {
    issue: K7,
    reason: 'fail',
    message: 'checks failed',
    runId: 'run-1',
    branch: 'issue-7-x',
    lane: 'lane-a',
    parkSha: 'a'.repeat(40),
    blockers: [3, 4],
    ...overrides,
  };
}

export interface FakeComment {
  id: number;
  body: string | null;
  user: { id: number };
}

export interface FakeOctokit {
  octokit: Octokit;
  store: FakeComment[];
  getAuthenticated: ReturnType<typeof vi.fn>;
  listComments: ReturnType<typeof vi.fn>;
  createComment: ReturnType<typeof vi.fn>;
  updateComment: ReturnType<typeof vi.fn>;
}

export function fakeOctokit(initial: FakeComment[] = []): FakeOctokit {
  const store = [...initial];
  let nextId = 1000;
  const getAuthenticated = vi.fn(async () => ({ data: { id: ME } }));
  const listComments = vi.fn(async ({ page, per_page }: { page: number; per_page: number }) => ({
    data: store.slice((page - 1) * per_page, page * per_page),
  }));
  const createComment = vi.fn(async ({ body }: { body: string }) => {
    const c = { id: nextId++, body, user: { id: ME } };
    store.push(c);
    return { data: c };
  });
  const updateComment = vi.fn(async ({ comment_id, body }: { comment_id: number; body: string }) => {
    const c = store.find((x) => x.id === comment_id);
    if (c) c.body = body;
    return { data: c };
  });
  const octokit = Object.assign({} as Octokit, {
    rest: { users: { getAuthenticated }, issues: { listComments, createComment, updateComment } },
  });
  return { octokit, store, getAuthenticated, listComments, createComment, updateComment };
}
