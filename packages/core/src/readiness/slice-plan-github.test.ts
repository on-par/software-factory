import { StorySchema } from '@on-par/contracts';
import type { Octokit } from '@octokit/rest';
import { describe, expect, it, vi } from 'vitest';

import { SLICE_PLAN_MARKER, renderSlicePlanComment } from './slice-plan.js';
import type { SlicePlan } from './slice-plan.js';
import { findSlicePlanComment, upsertSlicePlanComment } from './slice-plan-github.js';

const BOT = 42;
const OTHER = 7;

function plan(issue: number): SlicePlan {
  const story = StorySchema.parse({
    kind: 'story',
    schemaVersion: 1,
    title: 'Slice',
    role: 'a maintainer',
    want: 'a slice',
    soThat: 'it ships',
    problemStatement: 'too big',
    inScope: ['one thing'],
    outOfScope: [],
    acceptanceCriteria: [{ name: 'works', given: [], when: ['it runs'], then: ['it passes'] }],
    verification: [{ command: 'npm test', passWhen: 'green' }],
    filesLikelyTouched: [],
    labels: [],
    tracesTo: [],
  });
  return { issue, slices: [{ index: 1, title: 'Slice', story, state: 'pending' }] };
}

interface FakeComment {
  id: number;
  user: { id: number } | null;
  body?: string;
}

const noise = (count: number): FakeComment[] =>
  Array.from({ length: count }, (_, i) => ({ id: 1000 + i, user: { id: OTHER }, body: `chatter ${i}` }));

function fake(comments: FakeComment[]) {
  const getAuthenticated = vi.fn().mockResolvedValue({ data: { id: BOT } });
  const listComments = vi.fn(async (args: { page: number; per_page: number }) => ({
    data: comments.slice((args.page - 1) * args.per_page, args.page * args.per_page),
  }));
  const createComment = vi.fn().mockResolvedValue({ data: { id: 9999 } });
  const updateComment = vi.fn().mockResolvedValue({ data: {} });
  const octokit = Object.assign({} as Octokit, {
    rest: { users: { getAuthenticated }, issues: { listComments, createComment, updateComment } },
  });
  return { octokit, getAuthenticated, listComments, createComment, updateComment };
}

const base = { repo: 'acme/widgets', issue: 5 };

describe('findSlicePlanComment', () => {
  it('finds a trusted marker comment past the first page', async () => {
    const body = renderSlicePlanComment(plan(5));
    const f = fake([...noise(150), { id: 555, user: { id: BOT }, body }]);
    const result = await findSlicePlanComment({ octokit: f.octokit, ...base });
    expect(result).toEqual({ status: 'found', commentId: 555, plan: plan(5) });
    expect(f.listComments.mock.calls.map(([a]) => a.page)).toEqual([1, 2]);
    expect(f.listComments).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'widgets',
      issue_number: 5,
      per_page: 100,
      page: 1,
    });
  });

  it('ignores marker comments from other users', async () => {
    const body = renderSlicePlanComment(plan(5));
    const only = fake([{ id: 1, user: { id: OTHER }, body }]);
    expect(await findSlicePlanComment({ octokit: only.octokit, ...base })).toEqual({ status: 'not-found' });
    const both = fake([
      { id: 1, user: { id: OTHER }, body },
      { id: 2, user: { id: BOT }, body },
    ]);
    expect(await findSlicePlanComment({ octokit: both.octokit, ...base })).toMatchObject({
      status: 'found',
      commentId: 2,
    });
  });

  it('returns invalid for an unreadable trusted marker comment', async () => {
    const f = fake([{ id: 3, user: { id: BOT }, body: `${SLICE_PLAN_MARKER}\nno data` }]);
    const result = await findSlicePlanComment({ octokit: f.octokit, ...base });
    expect(result).toMatchObject({ status: 'invalid', commentId: 3 });
    expect(result.status === 'invalid' && result.error.length).toBeGreaterThan(0);
  });

  it('returns invalid when the plan is for another issue', async () => {
    const f = fake([{ id: 4, user: { id: BOT }, body: renderSlicePlanComment(plan(6)) }]);
    expect(await findSlicePlanComment({ octokit: f.octokit, ...base })).toEqual({
      status: 'invalid',
      commentId: 4,
      error: 'slice plan is for #6, not #5',
    });
  });

  it('skips comments with no user or no body', async () => {
    const f = fake([
      { id: 1, user: null, body: renderSlicePlanComment(plan(5)) },
      { id: 2, user: { id: BOT }, body: undefined },
    ]);
    expect(await findSlicePlanComment({ octokit: f.octokit, ...base })).toEqual({ status: 'not-found' });
  });

  it('requests the empty next page after exactly one full page', async () => {
    const f = fake(noise(100));
    expect(await findSlicePlanComment({ octokit: f.octokit, ...base })).toEqual({ status: 'not-found' });
    expect(f.listComments).toHaveBeenCalledTimes(2);
  });

  it('propagates a getAuthenticated rejection', async () => {
    const f = fake([]);
    f.getAuthenticated.mockRejectedValue(new Error('bad credentials'));
    await expect(findSlicePlanComment({ octokit: f.octokit, ...base })).rejects.toThrow('bad credentials');
  });
});

describe('upsertSlicePlanComment', () => {
  const body = renderSlicePlanComment(plan(5));

  it('creates the comment when none exists', async () => {
    const f = fake([]);
    const result = await upsertSlicePlanComment({ octokit: f.octokit, ...base, plan: plan(5) });
    expect(result).toEqual({ commentId: 9999, created: true });
    expect(f.createComment).toHaveBeenCalledOnce();
    expect(f.createComment).toHaveBeenCalledWith({ owner: 'acme', repo: 'widgets', issue_number: 5, body });
    expect(f.updateComment).not.toHaveBeenCalled();
  });

  it('updates the trusted comment in place, never a foreign one', async () => {
    const f = fake([
      { id: 1, user: { id: OTHER }, body },
      { id: 2, user: { id: BOT }, body },
    ]);
    const result = await upsertSlicePlanComment({ octokit: f.octokit, ...base, plan: plan(5) });
    expect(result).toEqual({ commentId: 2, created: false });
    expect(f.updateComment).toHaveBeenCalledOnce();
    expect(f.updateComment).toHaveBeenCalledWith({ owner: 'acme', repo: 'widgets', comment_id: 2, body });
    expect(f.createComment).not.toHaveBeenCalled();
  });

  it('creates a new comment when only a foreign marker comment exists', async () => {
    const f = fake([{ id: 1, user: { id: OTHER }, body }]);
    const result = await upsertSlicePlanComment({ octokit: f.octokit, ...base, plan: plan(5) });
    expect(result.created).toBe(true);
    expect(f.updateComment).not.toHaveBeenCalled();
  });

  it('repairs an invalid trusted comment by updating its id', async () => {
    const f = fake([{ id: 8, user: { id: BOT }, body: `${SLICE_PLAN_MARKER}\ngarbled` }]);
    const result = await upsertSlicePlanComment({ octokit: f.octokit, ...base, plan: plan(5) });
    expect(result).toEqual({ commentId: 8, created: false });
    expect(f.updateComment).toHaveBeenCalledWith(expect.objectContaining({ comment_id: 8 }));
    expect(f.createComment).not.toHaveBeenCalled();
  });
});
