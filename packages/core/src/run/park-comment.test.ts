import type { Octokit } from '@octokit/rest';
import { describe, expect, it, vi } from 'vitest';
import { fakeOctokit } from '../harness/fake-octokit.js';

import type { ParkReason } from './outcome.js';
import { workKeyFromIssue } from '../work/work-key.js';
import {
  environmentReleaseMarker,
  findOwnParkComment,
  issueStateMarker,
  parkPayload,
  parkUnblockHint,
  publishParkComment,
  readParkedOrder,
  readParkState,
  renderParkComment,
  upsertMarkerComment,
  upsertParkComment,
  type ParkCommentInput,
} from './park-comment.js';

const K7 = workKeyFromIssue(7);

const ME = 99;
const REASONS: ParkReason[] = [
  'escalate',
  'timeout',
  'fail',
  'conflict',
  'ci-failed',
  'ci-infra',
  'held',
  'config',
  'blocked',
  'all_providers_down',
  'sandbox-env',
];

function input(overrides: Partial<ParkCommentInput> = {}): ParkCommentInput {
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

interface FakeComment {
  id: number;
  body: string | null;
  user: { id: number };
}

function octokitFixture(initial: FakeComment[] = []) {
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
  const { octokit } = fakeOctokit({
    'users.getAuthenticated': getAuthenticated,
    'issues.listComments': listComments,
    'issues.createComment': createComment,
    'issues.updateComment': updateComment,
  });
  return { octokit: octokit as Octokit, store, getAuthenticated, listComments, createComment, updateComment };
}

describe('issueStateMarker', () => {
  it('returns the exact hidden marker', () => {
    expect(issueStateMarker(K7)).toBe('<!-- factory-issue-state v1 issue:7 -->');
  });
});

describe('parkUnblockHint', () => {
  it.each(REASONS)('returns a single-line hint containing the issue number for %s', (reason) => {
    const hint = parkUnblockHint(reason, workKeyFromIssue(42));
    expect(hint.length).toBeGreaterThan(0);
    expect(hint).not.toContain('\n');
    expect(hint).toContain('42');
    expect(hint).not.toContain('<n>');
  });
});

describe('parkPayload (#3511)', () => {
  it('carries the reason, the unblock hint as decision, the lane and a copy of blockedBehind', () => {
    const behind = [8, 9];
    const payload = parkPayload('escalate', K7, 'app', behind);
    expect(payload).toEqual({
      reason: 'escalate',
      decision: parkUnblockHint('escalate', K7),
      lane: 'app',
      blockedBehind: [8, 9],
    });
    expect(payload.blockedBehind).not.toBe(behind);
  });

  it("defaults the lane to ''", () => {
    expect(parkPayload('fail', workKeyFromIssue(3), undefined, []).lane).toBe('');
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
    expect(body.endsWith(issueStateMarker(K7))).toBe(true);
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
    expect(readParkState([{ id: 1, body }], K7)).toEqual({
      reason: 'fail',
      autoUnparks: 0,
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
    expect(readParkState([{ id: 1, body: renderParkComment(input({ issue: workKeyFromIssue(8) })) }], K7)).toBeNull();
  });

  it('returns null for a marker without a state block or without a reason line', () => {
    const marker = issueStateMarker(K7);
    expect(readParkState([{ id: 1, body: `hello\n${marker}` }])).toBeNull();
    expect(readParkState([{ id: 1, body: `**Park state**\n\nno fence here\n${marker}` }])).toBeNull();
    expect(readParkState([{ id: 1, body: `**Park state**\n\`\`\`\`\`\nreason: x\n${marker}` }])).toBeNull();
    expect(
      readParkState([{ id: 1, body: `**Park state**\n\`\`\`\`\`\nnot a pair\nlane: a\n\`\`\`\`\`\n${marker}` }]),
    ).toBeNull();
  });

  it('reads a state block with only a reason line as no lane, SHA or blockers', () => {
    const body = `**Park state**\n\n\`\`\`\`\`\nreason: fail\n\`\`\`\`\`\n${issueStateMarker(K7)}`;
    expect(readParkState([{ id: 1, body }])).toEqual({ reason: 'fail', blockers: [], autoUnparks: 0 });
  });

  it('names the denied loopback bind and #3081 in the sandbox-env hint (#3332)', () => {
    const hint = parkUnblockHint('sandbox-env', K7);
    expect(hint).toContain('EPERM');
    expect(hint).toContain('#3081');
    expect(hint).toContain('factory unpark 7');
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
    const f = octokitFixture();
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
    const f = octokitFixture([{ id: 1, body: issueStateMarker(K7), user: { id: 5 } }]);
    const result = await upsertParkComment({ octokit: f.octokit, repo: 'o/r', input: input() });
    expect(result.created).toBe(true);
    expect(f.updateComment).not.toHaveBeenCalled();
  });

  it('finds the lowest-id marker comment across pages', async () => {
    const filler: FakeComment[] = Array.from({ length: 100 }, (_, i) => ({ id: i + 10, body: 'x', user: { id: ME } }));
    const f = octokitFixture([
      ...filler,
      { id: 500, body: issueStateMarker(K7), user: { id: ME } },
      { id: 600, body: issueStateMarker(K7), user: { id: ME } },
    ]);
    const result = await upsertParkComment({ octokit: f.octokit, repo: 'o/r', input: input() });
    expect(result).toEqual({ commentId: 500, created: false });
    expect(f.listComments).toHaveBeenCalledTimes(2);
  });

  it('keeps the lowest id when a later page entry comes first in order', async () => {
    const f = octokitFixture([
      { id: 9, body: issueStateMarker(K7), user: { id: ME } },
      { id: 3, body: issueStateMarker(K7), user: { id: ME } },
    ]);
    expect((await upsertParkComment({ octokit: f.octokit, repo: 'o/r', input: input() })).commentId).toBe(3);
  });

  it('treats a comment with a null body as unmarked', async () => {
    const f = octokitFixture([{ id: 1, body: null, user: { id: ME } }]);
    expect((await upsertParkComment({ octokit: f.octokit, repo: 'o/r', input: input() })).created).toBe(true);
  });
});

describe('publishParkComment', () => {
  const { parkSha: _omit, ...base } = input();

  it('puts the readHead SHA in the body', async () => {
    const f = octokitFixture();
    const readHead = vi.fn(async () => 'b'.repeat(40));
    const r = await publishParkComment({ octokit: f.octokit, repo: 'o/r', worktree: '/wt', input: base, readHead });
    expect(r).toMatchObject({ ok: true, created: true });
    expect(f.store[0].body).toContain(`park-sha: ${'b'.repeat(40)}`);
  });

  it('still posts with park-sha - when readHead rejects or returns empty', async () => {
    for (const readHead of [vi.fn().mockRejectedValue(new Error('no git')), vi.fn().mockResolvedValue('')]) {
      const f = octokitFixture();
      const r = await publishParkComment({ octokit: f.octokit, repo: 'o/r', worktree: '/wt', input: base, readHead });
      expect(r.ok).toBe(true);
      expect(f.store[0].body).toContain('park-sha: -');
    }
  });

  it('does not call readHead without a worktree', async () => {
    const f = octokitFixture();
    const readHead = vi.fn();
    await publishParkComment({ octokit: f.octokit, repo: 'o/r', input: base, readHead });
    expect(readHead).not.toHaveBeenCalled();
  });

  it('returns { ok: false } instead of throwing when GitHub fails', async () => {
    const create = octokitFixture();
    create.createComment.mockRejectedValue(new Error('create boom'));
    expect(await publishParkComment({ octokit: create.octokit, repo: 'o/r', input: base })).toEqual({
      ok: false,
      error: 'create boom',
    });

    const update = octokitFixture([{ id: 1, body: issueStateMarker(K7), user: { id: ME } }]);
    update.updateComment.mockRejectedValue(new Error('update boom'));
    expect(await publishParkComment({ octokit: update.octokit, repo: 'o/r', input: base })).toMatchObject({
      ok: false,
      error: 'update boom',
    });

    const auth = octokitFixture();
    auth.getAuthenticated.mockRejectedValue('plain string');
    expect(await publishParkComment({ octokit: auth.octokit, repo: 'o/r', input: base })).toEqual({
      ok: false,
      error: 'plain string',
    });
  });
});

describe('park comment counter and status', () => {
  it('renders auto-unparks and status only when set, leaving the default output unchanged', () => {
    const plain = renderParkComment(input());
    expect(plain).not.toContain('auto-unparks');
    expect(plain).not.toContain('status:');
    expect(renderParkComment(input({ autoUnparks: 0 }))).toBe(plain);
    const body = renderParkComment(input({ autoUnparks: 2, status: 'held: x\ny' }));
    expect(body).toContain('auto-unparks: 2');
    expect(body).toContain('status: held: x y');
  });

  it('parses auto-unparks (malformed gives 0) and status', () => {
    const read = (b: string) => readParkState([{ id: 1, body: b }], K7)!;
    expect(read(renderParkComment(input())).autoUnparks).toBe(0);
    expect(read(renderParkComment(input())).status).toBeUndefined();
    const ok = read(renderParkComment(input({ autoUnparks: 2, status: 'resumed' })));
    expect(ok.autoUnparks).toBe(2);
    expect(ok.status).toBe('resumed');
    const bad = renderParkComment(input({ autoUnparks: 2 })).replace('auto-unparks: 2', 'auto-unparks: two');
    expect(read(bad).autoUnparks).toBe(0);
    const huge = renderParkComment(input({ autoUnparks: 2 })).replace(
      'auto-unparks: 2',
      'auto-unparks: 99999999999999999999',
    );
    expect(read(huge).autoUnparks).toBe(0);
  });
});

describe('findOwnParkComment', () => {
  it('returns undefined when none match and ignores foreign authors and null bodies', async () => {
    const f = octokitFixture([
      { id: 1, body: issueStateMarker(K7), user: { id: 5 } },
      { id: 2, body: null, user: { id: ME } },
    ]);
    expect(await findOwnParkComment({ octokit: f.octokit, repo: 'o/r', issue: K7 })).toBeUndefined();
  });

  it('returns the lowest-id own marker comment across pages', async () => {
    const filler: FakeComment[] = Array.from({ length: 100 }, (_, i) => ({ id: i + 10, body: 'x', user: { id: ME } }));
    const f = octokitFixture([
      ...filler,
      { id: 600, body: issueStateMarker(K7), user: { id: ME } },
      { id: 500, body: issueStateMarker(K7), user: { id: ME } },
    ]);
    expect(await findOwnParkComment({ octokit: f.octokit, repo: 'o/r', issue: K7 })).toEqual({
      id: 500,
      body: issueStateMarker(K7),
    });
  });
});

describe('upsertParkComment auto-unparks counter', () => {
  it('carries the counter from the existing comment on a re-park', async () => {
    const f = octokitFixture([{ id: 1, body: renderParkComment(input({ autoUnparks: 2 })), user: { id: ME } }]);
    await upsertParkComment({ octokit: f.octokit, repo: 'o/r', input: input({ reason: 'config' }) });
    expect(f.store[0].body).toContain('auto-unparks: 2');
    expect(f.store[0].body).toContain('reason: config');
  });

  it('lets an explicit autoUnparks win', async () => {
    const f = octokitFixture([{ id: 1, body: renderParkComment(input({ autoUnparks: 2 })), user: { id: ME } }]);
    await upsertParkComment({ octokit: f.octokit, repo: 'o/r', input: input({ autoUnparks: 1 }) });
    expect(f.store[0].body).toContain('auto-unparks: 1');
  });

  it('starts at zero when the existing comment is unreadable', async () => {
    const f = octokitFixture([{ id: 1, body: issueStateMarker(K7), user: { id: ME } }]);
    await upsertParkComment({ octokit: f.octokit, repo: 'o/r', input: input() });
    expect(f.store[0].body).not.toContain('auto-unparks');
  });
});

describe('upsertMarkerComment', () => {
  const marker = environmentReleaseMarker(K7);

  it('has a marker distinct from the park-state marker', () => {
    expect(marker).toBe('<!-- factory-environment-release v1 issue:7 -->');
    expect(marker).not.toBe(issueStateMarker(K7));
  });

  it('creates when no own marker comment exists, appending a missing marker', async () => {
    const f = octokitFixture([{ id: 1, body: `foreign ${marker}`, user: { id: 5 } }]);
    const result = await upsertMarkerComment({
      octokit: f.octokit,
      repo: 'o/r',
      issue: K7,
      marker,
      body: 'hello',
    });
    expect(result).toEqual({ commentId: 1000, created: true });
    expect(f.updateComment).not.toHaveBeenCalled();
    expect(f.store[1].body).toBe(`hello\n${marker}`);
  });

  it('updates the lowest-id own comment when one exists', async () => {
    const f = octokitFixture([
      { id: 600, body: marker, user: { id: ME } },
      { id: 500, body: marker, user: { id: ME } },
    ]);
    const body = `new\n${marker}`;
    const result = await upsertMarkerComment({
      octokit: f.octokit,
      repo: 'o/r',
      issue: K7,
      marker,
      body,
    });
    expect(result).toEqual({ commentId: 500, created: false });
    expect(f.createComment).not.toHaveBeenCalled();
    expect(f.store.find((c) => c.id === 500)?.body).toBe(body);
  });

  it('does not touch a park-state comment', async () => {
    const f = octokitFixture([{ id: 1, body: issueStateMarker(K7), user: { id: ME } }]);
    const result = await upsertMarkerComment({
      octokit: f.octokit,
      repo: 'o/r',
      issue: K7,
      marker,
      body: 'x',
    });
    expect(result.created).toBe(true);
    expect(f.store[0].body).toBe(issueStateMarker(K7));
  });
});

describe('park-time order (#3554)', () => {
  const withLabels = (f: ReturnType<typeof octokitFixture>, names: string[] | Error) => {
    const listLabelsOnIssue = vi.fn(async () => {
      if (names instanceof Error) throw names;
      return { data: names.map((name) => ({ name })) };
    });
    Object.assign(f.octokit.rest.issues, { listLabelsOnIssue });
    return listLabelsOnIssue;
  };
  const { parkSha: _omit, ...base } = input();

  it('renders and parses the order line, absent when unset', () => {
    const body = renderParkComment(input({ order: 5 }));
    expect(body).toContain('order: 5');
    expect(readParkState([{ id: 1, body }])?.order).toBe(5);
    expect(renderParkComment(input())).not.toContain('order:');
    expect(readParkState([{ id: 1, body: renderParkComment(input()) }])?.order).toBeUndefined();
  });

  it('parses a malformed order as undefined', () => {
    const body = renderParkComment(input({ order: 5 })).replace('order: 5', 'order: x');
    expect(readParkState([{ id: 1, body }])?.order).toBeUndefined();
  });

  it('upsert keeps the previously recorded order when the input has none', async () => {
    const f = octokitFixture([{ id: 1, body: renderParkComment(input({ order: 5 })), user: { id: ME } }]);
    await upsertParkComment({ octokit: f.octokit, repo: 'o/r', input: input() });
    expect(f.store[0].body).toContain('order: 5');
    await upsertParkComment({ octokit: f.octokit, repo: 'o/r', input: input({ order: 9 }) });
    expect(f.store[0].body).toContain('order: 9');
  });

  it('publishParkComment records the single order label', async () => {
    const f = octokitFixture();
    withLabels(f, ['bug', 'factory:order:7']);
    await publishParkComment({ octokit: f.octokit, repo: 'o/r', input: base });
    expect(f.store[0].body).toContain('order: 7');
  });

  it('publishParkComment skips zero, several or malformed order labels', async () => {
    for (const names of [[], ['factory:order:1', 'factory:order:2'], ['factory:order:x']]) {
      const f = octokitFixture();
      withLabels(f, names);
      await publishParkComment({ octokit: f.octokit, repo: 'o/r', input: base });
      expect(f.store[0].body).not.toContain('order:');
    }
  });

  it('publishParkComment survives a throwing label read and honours readOrder', async () => {
    const f = octokitFixture();
    withLabels(f, new Error('boom'));
    expect(await publishParkComment({ octokit: f.octokit, repo: 'o/r', input: base })).toMatchObject({ ok: true });
    expect(f.store[0].body).not.toContain('order:');
    const g = octokitFixture();
    await publishParkComment({ octokit: g.octokit, repo: 'o/r', input: base, readOrder: async () => 4 });
    expect(g.store[0].body).toContain('order: 4');
  });

  it('readParkedOrder returns the recorded order, undefined without a comment', async () => {
    const f = octokitFixture([{ id: 1, body: renderParkComment(input({ order: 5 })), user: { id: ME } }]);
    expect(await readParkedOrder({ octokit: f.octokit, repo: 'o/r', issue: K7 })).toBe(5);
    expect(await readParkedOrder({ octokit: octokitFixture().octokit, repo: 'o/r', issue: K7 })).toBeUndefined();
  });
});
