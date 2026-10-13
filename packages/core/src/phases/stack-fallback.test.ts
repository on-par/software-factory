import { StorySchema } from '@on-par/contracts';
import type { Octokit } from '@octokit/rest';
import { describe, expect, it, vi } from 'vitest';

import { parseSlicePlanComment } from '../readiness/slice-plan.js';
import type { SlicePlan } from '../readiness/slice-plan.js';
import { shipSliceStack } from './stack-fallback.js';

const BOT = 42;

function story(n: number) {
  return StorySchema.parse({
    kind: 'story',
    schemaVersion: 1,
    title: `Story ${n}`,
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
}

const plan: SlicePlan = {
  issue: 5,
  slices: [1, 2, 3].map((i) => ({ index: i, title: `Story ${i}`, story: story(i), state: 'pending' as const })),
};

const slice = (index: number) => ({ index, branch: `b${index}`, diffStat: ' 1 file changed' });
const all = [slice(1), slice(2), slice(3)];
const notFound = () => Object.assign(new Error('Not Found'), { status: 404 });

function fake(
  opts: {
    create?: ReturnType<typeof vi.fn>;
    request?: ReturnType<typeof vi.fn>;
    update?: ReturnType<typeof vi.fn>;
  } = {},
) {
  let n = 100;
  const create = opts.create ?? vi.fn().mockImplementation(async () => ({ data: { number: ++n } }));
  const request = opts.request ?? vi.fn().mockRejectedValue(notFound());
  const update = opts.update ?? vi.fn().mockResolvedValue({ data: {} });
  const createComment = vi.fn().mockResolvedValue({ data: { id: 1 } });
  const octokit = Object.assign({} as Octokit, {
    rest: {
      pulls: { create, list: vi.fn().mockResolvedValue({ data: [] }), update },
      users: { getAuthenticated: vi.fn().mockResolvedValue({ data: { id: BOT } }) },
      issues: { listComments: vi.fn().mockResolvedValue({ data: [] }), createComment, updateComment: vi.fn() },
    },
    request,
  });
  return { octokit, create, request, update, createComment };
}

const run = (f: ReturnType<typeof fake>, slices = all, log = vi.fn()) =>
  shipSliceStack({ octokit: f.octokit, repo: 'acme/widgets', issue: 5, title: 'Big', plan, slices, log });

function lastRecorded(f: ReturnType<typeof fake>) {
  const calls = f.createComment.mock.calls;
  const parsed = parseSlicePlanComment(calls[calls.length - 1]![0].body);
  if (!parsed?.ok) throw new Error('unparseable plan comment');
  return parsed.plan.slices;
}

describe('shipSliceStack', () => {
  it('falls back to slice mode on a stack API failure, keeping only slice 1 open on main', async () => {
    const f = fake();
    const res = await run(f);
    expect(res.mode).toBe('slice');
    if (res.mode !== 'slice') return;
    expect(res.pr.prNumber).toBe(101);
    expect(res.pr.base).toBe('main');
    expect(res.closedPrs).toEqual([103, 102]);
    expect(res.cleanupErrors).toEqual([]);
    expect(f.update.mock.calls.map((c) => [c[0].pull_number, c[0].state])).toEqual([
      [103, 'closed'],
      [102, 'closed'],
    ]);
    const states = lastRecorded(f);
    expect(states.map((s) => s.state)).toEqual(['pr-open', 'pending', 'pending']);
    expect([states[0]!.prNumber, states[0]!.branch]).toEqual([101, 'b1']);
    expect(states[1]!.prNumber).toBeUndefined();
    expect(states[2]!.prNumber).toBeUndefined();
  });

  it('logs one stack-fallback event naming the stack API error', async () => {
    const f = fake();
    const log = vi.fn();
    await run(f, all, log);
    const events = log.mock.calls.filter((c) => c[0] === 'stack-fallback');
    expect(events).toHaveLength(1);
    for (const text of ['stack mode abandoned', '#5', 'Not Found', 'slice mode']) {
      expect(events[0]![1]).toContain(text);
    }
  });

  it('does not fall back when the stack links', async () => {
    const f = fake({ request: vi.fn().mockResolvedValue({ data: { number: 7 } }) });
    const log = vi.fn();
    const res = await run(f, all, log);
    expect(res.mode).toBe('stack');
    if (res.mode === 'stack') expect(res.stack.ok).toBe(true);
    expect(f.update).not.toHaveBeenCalled();
    expect(log.mock.calls.some((c) => c[0] === 'stack-fallback')).toBe(false);
  });

  it('does not fall back when a PR fails to open before the stack call', async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce({ data: { number: 101 } })
      .mockRejectedValueOnce(new Error('nope'));
    const f = fake({ create });
    const res = await run(f);
    expect(res.mode).toBe('stack');
    expect(f.request).not.toHaveBeenCalled();
    expect(f.update).not.toHaveBeenCalled();
  });

  it('keeps going when closing an upper PR fails', async () => {
    const update = vi.fn().mockImplementation(async (a: { pull_number: number }) => {
      if (a.pull_number === 103) throw new Error('locked');
      return { data: {} };
    });
    const f = fake({ update });
    const res = await run(f);
    expect(res.mode).toBe('slice');
    if (res.mode !== 'slice') return;
    expect(res.closedPrs).toEqual([102]);
    expect(res.cleanupErrors).toHaveLength(1);
    expect(res.cleanupErrors[0]).toContain('#103');
  });

  it('single built slice: no PRs to close', async () => {
    const f = fake();
    const log = vi.fn();
    const res = await run(f, [slice(1)], log);
    expect(res.mode).toBe('slice');
    if (res.mode !== 'slice') return;
    expect(res.closedPrs).toEqual([]);
    expect(f.update).not.toHaveBeenCalled();
    expect(log.mock.calls.find((c) => c[0] === 'stack-fallback')![1]).toContain('no other PRs');
  });

  it('applies notBuilt to the reset comment and reports a comment rewrite failure', async () => {
    const f = fake();
    const res = await shipSliceStack({
      octokit: f.octokit,
      repo: 'acme/widgets',
      issue: 5,
      title: 'Big',
      plan,
      slices: [slice(1)],
      notBuilt: [2, 3],
      log: vi.fn(),
    });
    expect(res.mode).toBe('slice');
    expect(lastRecorded(f).map((s) => s.state)).toEqual(['pr-open', 'not-built', 'not-built']);

    const g = fake();
    g.createComment.mockRejectedValue(new Error('rate limited'));
    const res2 = await run(g);
    expect(res2.mode).toBe('slice');
    if (res2.mode === 'slice') {
      expect(res2.reason).toBe('Not Found');
      expect(res2.cleanupErrors.some((e) => e.includes('rate limited'))).toBe(true);
    }
  });
});
