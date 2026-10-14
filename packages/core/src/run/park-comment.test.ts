import type { Octokit } from '@octokit/rest';
import { describe, expect, it, vi } from 'vitest';

import type { ParkReason } from './outcome.js';
import {
  issueStateMarker,
  parkUnblockHint,
  publishParkComment,
  readParkState,
  renderParkComment,
  upsertParkComment,
  type ParkCommentInput,
} from './park-comment.js';

const ME = 99;
const REASONS: ParkReason[] = ['escalate', 'timeout', 'fail', 'conflict', 'ci-failed', 'ci-infra', 'held', 'config'];

function input(overrides: Partial<ParkCommentInput> = {}): ParkCommentInput {
  return {
    issue: 7,
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

interface FakeComment {
  id: number;
  body: string | null;
  user: { id: number };
}

function fakeOctokit(initial: FakeComment[] = []) {
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

describe('issueStateMarker', () => {
  it('returns the exact hidden marker', () => {
    expect(issueStateMarker(7)).toBe('<!-- factory-issue-state v1 issue:7 -->');
  });
});

describe('parkUnblockHint', () => {
  it.each(REASONS)('returns a single-line hint containing the issue number for %s', (reason) => {
    const hint = parkUnblockHint(reason, 42);
    expect(hint.length).toBeGreaterThan(0);
    expect(hint).not.toContain('\n');
    expect(hint).toContain('42');
    expect(hint).not.toContain('<n>');
  });
});

describe('renderParkComment', () => {
  it('strips hidden content, fences backtick runs, and leaves the marker as the only HTML comment', () => {
    const body = renderParkComment(
      input({
        message: 'bad <!-- evil --> text ​ `````` ` ``````` end <!-- open',
        branch: 'br<!-- evil -->​anch\nsecond',
      }),
    );
    expect(body).not.toContain('​');
    expect(body).not.toContain('evil');
    expect(body.match(/<!--/g)).toHaveLength(1);
    expect(body.endsWith(issueStateMarker(7))).toBe(true);
    expect(body).toContain('`'.repeat(8));
    expect(body).toContain('branch: branch second');
  });

  it('renders dashes for absent lane, SHA and blockers', () => {
    const body = renderParkComment(input({ lane: undefined, parkSha: undefined, blockers: undefined }));
    expect(body).toContain('lane: -');
    expect(body).toContain('park-sha: -');
    expect(body).toContain('blockers: -');
  });
});

describe('readParkState', () => {
  it('round-trips reason, lane, branch, park SHA and blockers from renderParkComment', () => {
    const body = renderParkComment(input());
    expect(readParkState([{ id: 1, body }], 7)).toEqual({
      reason: 'fail',
      lane: 'lane-a',
      runId: 'run-1',
      branch: 'issue-7-x',
      parkSha: 'a'.repeat(40),
      blockers: [3, 4],
    });
  });

  it('round-trips undefined lane/SHA and empty blockers', () => {
    const body = renderParkComment(input({ lane: undefined, parkSha: undefined, blockers: [] }));
    const state = readParkState([{ id: 1, body }]);
    expect(state?.lane).toBeUndefined();
    expect(state?.parkSha).toBeUndefined();
    expect(state?.blockers).toEqual([]);
  });

  it('returns null without comments or for a marker of another issue', () => {
    expect(readParkState([])).toBeNull();
    expect(readParkState([{ id: 1, body: renderParkComment(input({ issue: 8 })) }], 7)).toBeNull();
  });

  it('returns null for a marker without a state block or without a reason line', () => {
    const marker = issueStateMarker(7);
    expect(readParkState([{ id: 1, body: `hello\n${marker}` }])).toBeNull();
    expect(readParkState([{ id: 1, body: `**Park state**\n\nno fence here\n${marker}` }])).toBeNull();
    expect(readParkState([{ id: 1, body: `**Park state**\n\`\`\`\`\`\nreason: x\n${marker}` }])).toBeNull();
    expect(
      readParkState([{ id: 1, body: `**Park state**\n\`\`\`\`\`\nnot a pair\nlane: a\n\`\`\`\`\`\n${marker}` }]),
    ).toBeNull();
  });

  it('reads a state block with only a reason line as no lane, SHA or blockers', () => {
    const body = `**Park state**\n\n\`\`\`\`\`\nreason: fail\n\`\`\`\`\`\n${issueStateMarker(7)}`;
    expect(readParkState([{ id: 1, body }])).toEqual({ reason: 'fail', blockers: [] });
  });

  it('lets the lowest id win among marked comments', () => {
    const a = renderParkComment(input({ reason: 'config' }));
    const b = renderParkComment(input({ reason: 'fail' }));
    expect(
      readParkState([
        { id: 5, body: b },
        { id: 2, body: a },
      ])?.reason,
    ).toBe('config');
  });
});

describe('upsertParkComment', () => {
  it('edits the existing marked comment on a second park instead of posting twice', async () => {
    const f = fakeOctokit();
    await upsertParkComment({ octokit: f.octokit, repo: 'o/r', input: input({ reason: 'fail' }) });
    const second = await upsertParkComment({ octokit: f.octokit, repo: 'o/r', input: input({ reason: 'config' }) });
    const marked = f.store.filter((c) => c.body?.includes('factory-issue-state'));
    expect(marked).toHaveLength(1);
    expect(marked[0].body).toContain('reason: config');
    expect(f.createComment).toHaveBeenCalledTimes(1);
    expect(f.updateComment).toHaveBeenCalledTimes(1);
    expect(second.created).toBe(false);
  });

  it('ignores a marker comment by another user and creates its own', async () => {
    const f = fakeOctokit([{ id: 1, body: issueStateMarker(7), user: { id: 5 } }]);
    const result = await upsertParkComment({ octokit: f.octokit, repo: 'o/r', input: input() });
    expect(result.created).toBe(true);
    expect(f.updateComment).not.toHaveBeenCalled();
  });

  it('finds the lowest-id marker comment across pages', async () => {
    const filler: FakeComment[] = Array.from({ length: 100 }, (_, i) => ({ id: i + 10, body: 'x', user: { id: ME } }));
    const f = fakeOctokit([
      ...filler,
      { id: 500, body: issueStateMarker(7), user: { id: ME } },
      { id: 600, body: issueStateMarker(7), user: { id: ME } },
    ]);
    const result = await upsertParkComment({ octokit: f.octokit, repo: 'o/r', input: input() });
    expect(result).toEqual({ commentId: 500, created: false });
    expect(f.listComments).toHaveBeenCalledTimes(2);
  });

  it('keeps the lowest id when a later page entry comes first in order', async () => {
    const f = fakeOctokit([
      { id: 9, body: issueStateMarker(7), user: { id: ME } },
      { id: 3, body: issueStateMarker(7), user: { id: ME } },
    ]);
    expect((await upsertParkComment({ octokit: f.octokit, repo: 'o/r', input: input() })).commentId).toBe(3);
  });

  it('treats a comment with a null body as unmarked', async () => {
    const f = fakeOctokit([{ id: 1, body: null, user: { id: ME } }]);
    expect((await upsertParkComment({ octokit: f.octokit, repo: 'o/r', input: input() })).created).toBe(true);
  });
});

describe('publishParkComment', () => {
  const { parkSha: _omit, ...base } = input();

  it('puts the readHead SHA in the body', async () => {
    const f = fakeOctokit();
    const readHead = vi.fn(async () => 'b'.repeat(40));
    const r = await publishParkComment({ octokit: f.octokit, repo: 'o/r', worktree: '/wt', input: base, readHead });
    expect(r).toMatchObject({ ok: true, created: true });
    expect(f.store[0].body).toContain(`park-sha: ${'b'.repeat(40)}`);
  });

  it('still posts with park-sha - when readHead rejects or returns empty', async () => {
    for (const readHead of [vi.fn().mockRejectedValue(new Error('no git')), vi.fn().mockResolvedValue('')]) {
      const f = fakeOctokit();
      const r = await publishParkComment({ octokit: f.octokit, repo: 'o/r', worktree: '/wt', input: base, readHead });
      expect(r.ok).toBe(true);
      expect(f.store[0].body).toContain('park-sha: -');
    }
  });

  it('does not call readHead without a worktree', async () => {
    const f = fakeOctokit();
    const readHead = vi.fn();
    await publishParkComment({ octokit: f.octokit, repo: 'o/r', input: base, readHead });
    expect(readHead).not.toHaveBeenCalled();
  });

  it('returns { ok: false } instead of throwing when GitHub fails', async () => {
    const create = fakeOctokit();
    create.createComment.mockRejectedValue(new Error('create boom'));
    expect(await publishParkComment({ octokit: create.octokit, repo: 'o/r', input: base })).toEqual({
      ok: false,
      error: 'create boom',
    });

    const update = fakeOctokit([{ id: 1, body: issueStateMarker(7), user: { id: ME } }]);
    update.updateComment.mockRejectedValue(new Error('update boom'));
    expect(await publishParkComment({ octokit: update.octokit, repo: 'o/r', input: base })).toMatchObject({
      ok: false,
      error: 'update boom',
    });

    const auth = fakeOctokit();
    auth.getAuthenticated.mockRejectedValue('plain string');
    expect(await publishParkComment({ octokit: auth.octokit, repo: 'o/r', input: base })).toEqual({
      ok: false,
      error: 'plain string',
    });
  });
});
