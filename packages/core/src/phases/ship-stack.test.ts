import { StorySchema } from '@on-par/contracts';
import type { Octokit } from '@octokit/rest';
import { describe, expect, it, vi } from 'vitest';

import { parseSlicePlanComment } from '../readiness/slice-plan.js';
import type { SlicePlan } from '../readiness/slice-plan.js';
import { openSliceStack } from './ship-stack.js';

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

function fake(opts: { create?: ReturnType<typeof vi.fn>; request?: ReturnType<typeof vi.fn>; list?: unknown[] } = {}) {
  let n = 100;
  const create = opts.create ?? vi.fn().mockImplementation(async () => ({ data: { number: ++n } }));
  const request = opts.request ?? vi.fn().mockResolvedValue({ data: { number: 7 } });
  const list = vi.fn().mockResolvedValue({ data: opts.list ?? [] });
  const createComment = vi.fn().mockResolvedValue({ data: { id: 1 } });
  const octokit = Object.assign({} as Octokit, {
    rest: {
      pulls: { create, list },
      users: { getAuthenticated: vi.fn().mockResolvedValue({ data: { id: BOT } }) },
      issues: { listComments: vi.fn().mockResolvedValue({ data: [] }), createComment, updateComment: vi.fn() },
    },
    request,
  });
  return { octokit, create, request, list, createComment };
}

const run = (f: ReturnType<typeof fake>, slices = all, log = vi.fn()) =>
  openSliceStack({ octokit: f.octokit, repo: 'acme/widgets', issue: 5, title: 'Big', plan, slices, log });

function recorded(f: ReturnType<typeof fake>) {
  const parsed = parseSlicePlanComment(f.createComment.mock.calls[0]![0].body);
  if (!parsed?.ok) throw new Error('unparseable plan comment');
  return parsed.plan.slices;
}

describe('openSliceStack', () => {
  it('opens 3 slice PRs in order and links them as one stack with the bottom PR on main', async () => {
    const f = fake();
    const res = await run(f);
    expect(f.create.mock.calls.map((c) => [c[0].head, c[0].base, c[0].draft])).toEqual([
      ['b1', 'main', true],
      ['b2', 'b1', true],
      ['b3', 'b2', true],
    ]);
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.request.mock.calls[0]![0]).toBe('POST /repos/{owner}/{repo}/stacks');
    expect(f.request.mock.calls[0]![1].pull_requests).toEqual([101, 102, 103]);
    expect(f.request.mock.invocationCallOrder[0]).toBeGreaterThan(f.create.mock.invocationCallOrder[2]!);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.stackNumber).toBe(7);
    expect(res.prs).toHaveLength(3);
  });

  it('puts Closes #<issue> only on the top PR and Part of #<issue> on the others', async () => {
    const f = fake();
    await run(f);
    const bodies = f.create.mock.calls.map((c) => c[0].body as string);
    for (const b of bodies.slice(0, 2)) {
      expect(b).toContain('Part of #5');
      expect(b).not.toContain('Closes #');
    }
    expect(bodies[2]).toContain('Closes #5');
    expect(f.create.mock.calls.map((c) => c[0].title)).toEqual([
      'Big — slice 1/3 (#5)',
      'Big — slice 2/3 (#5)',
      'Big — slice 3/3 (#5)',
    ]);
  });

  it('records every PR and branch in the slice-plan comment', async () => {
    const f = fake();
    await run(f);
    expect(f.createComment).toHaveBeenCalledTimes(1);
    expect(recorded(f).map((s) => [s.state, s.prNumber, s.branch])).toEqual([
      ['pr-open', 101, 'b1'],
      ['pr-open', 102, 'b2'],
      ['pr-open', 103, 'b3'],
    ]);
  });

  it('never closes the issue on a partial stack and leaves the missing slice pending', async () => {
    const f = fake();
    await run(f, [slice(1), slice(2)]);
    for (const c of f.create.mock.calls) expect(c[0].body).not.toContain('Closes #');
    expect(recorded(f)[2]!.state).toBe('pending');
  });

  it('reports a stack API failure without falling back, still recording the PRs', async () => {
    const f = fake({ request: vi.fn().mockRejectedValue(new Error('boom')) });
    const res = await run(f);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('stack');
    expect(res.prs).toHaveLength(3);
    expect(f.create).toHaveBeenCalledTimes(3);
    expect(recorded(f).every((s) => s.state === 'pr-open')).toBe(true);
  });

  it('stops on a non-422 pulls.create error and records the slices opened so far', async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce({ data: { number: 101 } })
      .mockRejectedValueOnce(new Error('nope'));
    const f = fake({ create });
    const res = await run(f);
    expect(res.ok).toBe(false);
    expect(res.prs).toHaveLength(1);
    expect(f.request).not.toHaveBeenCalled();
    expect(recorded(f).map((s) => s.state)).toEqual(['pr-open', 'pending', 'pending']);
  });

  it('reuses the existing PR on a 422 "already exists"', async () => {
    const exists = Object.assign(new Error('Validation Failed: A pull request already exists'), { status: 422 });
    const create = vi
      .fn()
      .mockResolvedValueOnce({ data: { number: 101 } })
      .mockRejectedValueOnce(exists)
      .mockResolvedValueOnce({ data: { number: 103 } });
    const f = fake({ create, list: [{ number: 202 }] });
    const log = vi.fn();
    const res = await run(f, all, log);
    expect(res.ok).toBe(true);
    expect(res.prs.map((p) => p.prNumber)).toEqual([101, 202, 103]);
    expect(log).toHaveBeenCalledWith('recovered', expect.stringContaining('#202'));
  });

  it('does nothing for empty slices', async () => {
    const f = fake();
    const res = await run(f, []);
    expect(res).toEqual({ ok: false, reason: 'no built slices to open', prs: [] });
    expect(f.create).not.toHaveBeenCalled();
    expect(f.request).not.toHaveBeenCalled();
    expect(f.createComment).not.toHaveBeenCalled();
  });

  it('records notBuilt slices as not-built in the same comment write', async () => {
    const f = fake();
    await openSliceStack({
      octokit: f.octokit,
      repo: 'acme/widgets',
      issue: 5,
      title: 'Big',
      plan,
      slices: [slice(1)],
      notBuilt: [2, 3],
      log: vi.fn(),
    });
    expect(f.createComment).toHaveBeenCalledTimes(1);
    expect(recorded(f).map((s) => s.state)).toEqual(['pr-open', 'not-built', 'not-built']);
  });
});
