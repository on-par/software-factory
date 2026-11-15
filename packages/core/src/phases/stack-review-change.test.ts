import { workKeyFromIssue } from '../work/work-key.js';
import { StorySchema } from '@on-par/contracts';
import type { Octokit } from '@octokit/rest';
import { describe, expect, it, vi } from 'vitest';

import { parseSlicePlanComment } from '../readiness/slice-plan.js';
import type { SlicePlan } from '../readiness/slice-plan.js';
import { detectLowerSliceChange, parkOnLowerSliceChange } from './stack-review-change.js';

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
  slices: [1, 2, 3].map((i) => ({
    index: i,
    title: `Story ${i}`,
    story: story(i),
    state: 'pr-open' as const,
    prNumber: 100 + i,
    branch: `b${i}`,
    headSha: `sha${i}`,
  })),
};

function fake(
  opts: {
    heads?: Record<number, string>;
    states?: Record<number, string>;
    getFails?: boolean;
    createCommentFails?: boolean;
  } = {},
) {
  const reads: number[] = [];
  const comments: Array<{ body: string }> = [];
  const get = async ({ pull_number }: { pull_number: number }) => {
    reads.push(pull_number);
    if (opts.getFails) throw new Error('boom');
    return {
      data: {
        state: opts.states?.[pull_number] ?? 'open',
        head: { sha: opts.heads?.[pull_number] ?? `sha${pull_number - 100}` },
      },
    };
  };
  const createComment = async (params: { body: string }) => {
    comments.push(params);
    if (opts.createCommentFails) throw new Error('nope');
    return { data: { id: 1 } };
  };
  const octokit = Object.assign({} as Octokit, {
    rest: {
      pulls: { get },
      users: { getAuthenticated: vi.fn().mockResolvedValue({ data: { id: BOT } }) },
      issues: { listComments: vi.fn().mockResolvedValue({ data: [] }), createComment, updateComment: vi.fn() },
    },
  });
  return { octokit, reads, comments };
}

function recordingLog() {
  const logged: Array<[string, string]> = [];
  return { logged, log: (type: string, msg: string): void => void logged.push([type, msg]) };
}

const loggedWith = (logged: Array<[string, string]>, type: string, text: string) =>
  logged.some(([t, m]) => t === type && m.includes(text));

const park = (
  f: ReturnType<typeof fake>,
  p: SlicePlan = plan,
  log: (type: string, msg: string) => void = () => undefined,
) => parkOnLowerSliceChange({ octokit: f.octokit, repo: 'acme/widgets', issue: workKeyFromIssue(5), plan: p, log });

function written(f: ReturnType<typeof fake>) {
  const body: string = f.comments[0]!.body;
  const parsed = parseSlicePlanComment(body);
  if (!parsed?.ok) throw new Error('unparseable plan comment');
  return { body, slices: parsed.plan.slices };
}

describe('parkOnLowerSliceChange', () => {
  it('parks the issue and names slices 2 and 3 when slice 1 PR head changed', async () => {
    const f = fake({ heads: { 101: 'new1' } });
    const { log, logged } = recordingLog();
    const res = await park(f, plan, log);
    expect(res?.outcome).toMatchObject({ state: 'parked', reason: 'escalate', prNumber: 101 });
    expect(res?.affected).toEqual([2, 3]);
    expect(res?.message).toContain('slices 2, 3');
    expect(logged).toContainEqual(['escalate', res?.message]);
    const { body, slices } = written(f);
    expect(slices.map((s) => s.affectedBy)).toEqual([undefined, 1, 1]);
    expect(body).toContain('affected by review changes to slice 1');
  });

  it('names only slice 3 when slice 2 changed', async () => {
    const res = await park(fake({ heads: { 102: 'new2' } }));
    expect(res?.affected).toEqual([3]);
    expect(res?.outcome.prNumber).toBe(102);
  });

  it('says there are no open upper slices when none remain', async () => {
    const p: SlicePlan = {
      ...plan,
      slices: plan.slices.map((s) => (s.index === 1 ? s : { ...s, state: 'not-built' as const })),
    };
    const res = await park(fake({ heads: { 101: 'new1' } }), p);
    expect(res?.affected).toEqual([]);
    expect(res?.message).toContain('no open upper slices');
  });

  it('returns undefined and writes nothing when no head changed', async () => {
    const f = fake();
    expect(await park(f)).toBeUndefined();
    expect(f.comments).toEqual([]);
  });

  it('ignores a change to the top slice only', async () => {
    const f = fake({ heads: { 103: 'new3' } });
    expect(await park(f)).toBeUndefined();
    expect(f.reads).toHaveLength(2);
  });

  it('does not flag a slice without a recorded head SHA and logs it', async () => {
    const p: SlicePlan = {
      ...plan,
      slices: plan.slices.map((s) => (s.index === 1 ? { ...s, headSha: undefined } : s)),
    };
    const { log, logged } = recordingLog();
    expect(await park(fake({ heads: { 101: 'new1' } }), p, log)).toBeUndefined();
    expect(loggedWith(logged, 'ship', 'slice 1/3 PR #101 has no recorded head SHA')).toBe(true);
  });

  it('skips slices above a merged slice (GitHub rebase)', async () => {
    const p: SlicePlan = {
      ...plan,
      slices: plan.slices.map((s) => (s.index === 1 ? { ...s, state: 'merged' as const } : s)),
    };
    const { log, logged } = recordingLog();
    expect(await park(fake({ heads: { 102: 'rebased' } }), p, log)).toBeUndefined();
    expect(loggedWith(logged, 'ship', 'merged')).toBe(true);
  });

  it('returns undefined when pulls.get rejects', async () => {
    const f = fake({ getFails: true });
    const { log, logged } = recordingLog();
    expect(await park(f, plan, log)).toBeUndefined();
    expect(loggedWith(logged, 'ship', 'boom')).toBe(true);
  });

  it('skips a closed PR', async () => {
    expect(await park(fake({ heads: { 101: 'new1' }, states: { 101: 'closed' } }))).toBeUndefined();
  });

  it('still returns the parked result when the comment write fails', async () => {
    const f = fake({ heads: { 101: 'new1' }, createCommentFails: true });
    const { log, logged } = recordingLog();
    const res = await park(f, plan, log);
    expect(res?.outcome.state).toBe('parked');
    expect(loggedWith(logged, 'ship', 'could not record the affected slices in the slice plan comment: nope')).toBe(
      true,
    );
  });
});

describe('detectLowerSliceChange', () => {
  it('reports status error when pulls.get rejects', async () => {
    const f = fake({ getFails: true });
    const res = await detectLowerSliceChange({ octokit: f.octokit, repo: 'acme/widgets', plan, log: vi.fn() });
    expect(res.status).toBe('error');
  });

  it('reports the lowest changed slice', async () => {
    const f = fake({ heads: { 101: 'n1', 102: 'n2' } });
    const res = await detectLowerSliceChange({ octokit: f.octokit, repo: 'acme/widgets', plan, log: vi.fn() });
    expect(res).toEqual({
      status: 'changed',
      change: { index: 1, prNumber: 101, recordedSha: 'sha1', currentSha: 'n1' },
    });
  });
});
