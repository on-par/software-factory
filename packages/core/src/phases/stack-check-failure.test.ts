import { StorySchema } from '@on-par/contracts';
import type { Octokit } from '@octokit/rest';
import { describe, expect, it, vi } from 'vitest';

import { parseSlicePlanComment } from '../readiness/slice-plan.js';
import type { SlicePlan } from '../readiness/slice-plan.js';
import { shipStackStoppedAtSlice } from './stack-check-failure.js';

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

function fake(opts: { request?: ReturnType<typeof vi.fn>; createComment?: ReturnType<typeof vi.fn> } = {}) {
  let n = 100;
  const create = vi.fn().mockImplementation(async () => ({ data: { number: ++n } }));
  const request = opts.request ?? vi.fn().mockResolvedValue({ data: { number: 7 } });
  const createComment = opts.createComment ?? vi.fn().mockResolvedValue({ data: { id: 1 } });
  const octokit = Object.assign({} as Octokit, {
    rest: {
      pulls: { create, list: vi.fn().mockResolvedValue({ data: [] }) },
      users: { getAuthenticated: vi.fn().mockResolvedValue({ data: { id: BOT } }) },
      issues: { listComments: vi.fn().mockResolvedValue({ data: [] }), createComment, updateComment: vi.fn() },
    },
    request,
  });
  return { octokit, create, request, createComment };
}

const run = (
  f: ReturnType<typeof fake>,
  built = [slice(1)],
  failure: Partial<Parameters<typeof shipStackStoppedAtSlice>[0]['failure']> = {},
  log = vi.fn(),
) =>
  shipStackStoppedAtSlice({
    octokit: f.octokit,
    repo: 'acme/widgets',
    issue: 5,
    title: 'Big',
    plan,
    built,
    failure: { index: 2, message: '2 check failures after 3 rework rounds', ...failure },
    log,
  });

function states(f: ReturnType<typeof fake>) {
  const parsed = parseSlicePlanComment(f.createComment.mock.calls[0]![0].body);
  if (!parsed?.ok) throw new Error('unparseable plan comment');
  return parsed.plan.slices;
}

describe('shipStackStoppedAtSlice', () => {
  it('opens slice 1 as a one-PR stack when slice 2 of 3 fails CHECK', async () => {
    const f = fake();
    const res = await run(f);
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.create.mock.calls[0]![0]).toMatchObject({ head: 'b1', base: 'main' });
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.request.mock.calls[0]![1].pull_requests).toEqual([101]);
    expect(res.stack?.ok).toBe(true);
    const body: string = f.create.mock.calls[0]![0].body;
    expect(body).toContain('Part of #5');
    expect(body).not.toContain('Closes #');
  });

  it('parks the issue and records slices 2 and 3 as not built', async () => {
    const f = fake();
    const res = await run(f, [slice(1)], { failureSignature: 'sig', failingChecks: ['tests'] });
    expect(res.outcome).toMatchObject({
      state: 'parked',
      reason: 'fail',
      failureSignature: 'sig',
      failingChecks: ['tests'],
      prNumber: 101,
    });
    expect(res.notBuilt).toEqual([2, 3]);
    expect(f.createComment).toHaveBeenCalledTimes(1);
    const slices = states(f);
    expect(slices.map((s) => s.state)).toEqual(['pr-open', 'not-built', 'not-built']);
    expect(slices[0]).toMatchObject({ prNumber: 101, branch: 'b1' });
    expect(res.message).toContain('slice 2/3');
    expect(res.message).toContain('not built');
  });

  it('opens nothing and records every slice as not built when slice 1 fails', async () => {
    const f = fake();
    const res = await run(f, [], { index: 1 });
    expect(f.create).not.toHaveBeenCalled();
    expect(f.request).not.toHaveBeenCalled();
    expect(states(f).map((s) => s.state)).toEqual(['not-built', 'not-built', 'not-built']);
    expect(res.outcome.state).toBe('parked');
    expect(res.stack).toBeUndefined();
    expect(res.message).toContain('no slices opened');
  });

  it('ignores a built slice at or above the failed index', async () => {
    const f = fake();
    await run(f, [slice(1), slice(2)]);
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.create.mock.calls[0]![0].head).toBe('b1');
  });

  it('still parks when the stack API errors and names the stack reason', async () => {
    const f = fake({ request: vi.fn().mockRejectedValue(new Error('stacks unavailable')) });
    const res = await run(f);
    expect(res.outcome.state).toBe('parked');
    expect(res.stack?.ok).toBe(false);
    expect(res.message).toContain('stacks unavailable');
  });

  it('still parks when the comment write rejects at slice 1, and logs the failure', async () => {
    const f = fake({ createComment: vi.fn().mockRejectedValue(new Error('boom')) });
    const log = vi.fn();
    const res = await run(f, [], { index: 1 }, log);
    expect(res.outcome.state).toBe('parked');
    expect(log).toHaveBeenCalledWith('ship', expect.stringContaining('boom'));
  });

  it('carries the CHECK park reason, branch and rework rounds into the outcome', async () => {
    const res = await run(fake(), [slice(1)], { parkReason: 'escalate', branch: 'b2', reworkRounds: 3 });
    expect(res.outcome).toMatchObject({ reason: 'escalate', branch: 'b2', reworkRounds: 3 });
  });

  it('throws RangeError for an unknown failure index', async () => {
    await expect(run(fake(), [slice(1)], { index: 9 })).rejects.toThrow(RangeError);
  });
});
