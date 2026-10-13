import { StorySchema } from '@on-par/contracts';
import type { Octokit } from '@octokit/rest';
import { describe, expect, it, vi } from 'vitest';

import {
  SLICE_PLAN_MARKER,
  markSliceMerged,
  parseSlicePlanComment,
  renderSlicePlanComment,
  withSliceState,
} from './slice-plan.js';
import type { SlicePlan } from './slice-plan.js';
import { recordSliceMerged } from './slice-plan-github.js';

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

function plan(count = 3, issue = 5): SlicePlan {
  return {
    issue,
    slices: Array.from({ length: count }, (_, i) => ({
      index: i + 1,
      title: `Story ${i + 1}`,
      story: story(i + 1),
      state: 'pending' as const,
    })),
  };
}

function fake(body: string | undefined) {
  const comments = body === undefined ? [] : [{ id: 77, user: { id: BOT }, body }];
  const updateComment = vi.fn().mockResolvedValue({ data: {} });
  const octokit = Object.assign({} as Octokit, {
    rest: {
      users: { getAuthenticated: vi.fn().mockResolvedValue({ data: { id: BOT } }) },
      issues: { listComments: vi.fn().mockResolvedValue({ data: comments }), updateComment },
    },
  });
  return { octokit, updateComment };
}

const base = { repo: 'acme/widgets', issue: 5 };

describe('slice plan comment branch and PR', () => {
  it('renders each slice with its branch and PR and round-trips them', () => {
    let p = withSliceState(plan(), 1, 'merged', 11, 'factory/7-a');
    p = withSliceState(p, 2, 'pr-open', 12, 'factory/7-s2-b');
    p = withSliceState(p, 3, 'not-built');
    const body = renderSlicePlanComment(p);
    const lines = body.split('\n').filter((l) => l.startsWith('- ['));
    expect(lines).toEqual([
      '- [x] 1/3. Story 1 — merged (#11) · branch `factory/7-a`',
      '- [ ] 2/3. Story 2 — PR open #12 · branch `factory/7-s2-b`',
      '- [ ] 3/3. Story 3 — not built',
    ]);
    expect(parseSlicePlanComment(body)).toEqual({ ok: true, plan: p });
  });

  it('withSliceState keeps an existing branch when none is passed', () => {
    const p = withSliceState(plan(), 1, 'pr-open', 3, 'factory/x');
    const next = withSliceState(p, 1, 'merged');
    expect(next.slices[0]?.branch).toBe('factory/x');
    expect(next.slices[0]?.prNumber).toBe(3);
  });

  it('markSliceMerged flips the slice with that PR, is a no-op when already merged, undefined when unknown', () => {
    const p = withSliceState(plan(), 2, 'pr-open', 12);
    const flipped = markSliceMerged(p, 12);
    expect(flipped?.index).toBe(2);
    expect(flipped?.changed).toBe(true);
    expect(flipped?.plan.slices[1]?.state).toBe('merged');
    const again = markSliceMerged(flipped!.plan, 12);
    expect(again).toMatchObject({ index: 2, changed: false });
    expect(markSliceMerged(p, 99)).toBeUndefined();
  });

  it('parses a v1 comment with no branch or PR fields', () => {
    const slices = [1, 2].map((i) => ({ index: i, title: `Story ${i}`, story: story(i), state: 'pending' }));
    const data = Buffer.from(JSON.stringify({ issue: 5, slices }), 'utf8').toString('base64');
    const body = `${SLICE_PLAN_MARKER}\n\n<!-- factory:slice-plan-data ${data} -->`;
    const parsed = parseSlicePlanComment(body);
    expect(parsed?.ok).toBe(true);
    if (parsed?.ok) {
      expect(parsed.plan.slices.some((s) => 'branch' in s)).toBe(false);
      expect(renderSlicePlanComment(parsed.plan)).toContain('- [ ] 1/2. Story 1 — pending\n');
    }
  });

  it('rejects an empty or non-string branch', () => {
    for (const branch of ['', 5]) {
      const p = plan(1);
      const slices = [{ ...p.slices[0], branch }];
      const data = Buffer.from(JSON.stringify({ issue: 5, slices }), 'utf8').toString('base64');
      const parsed = parseSlicePlanComment(`${SLICE_PLAN_MARKER}\n<!-- factory:slice-plan-data ${data} -->`);
      expect(parsed?.ok).toBe(false);
    }
  });
});

describe('recordSliceMerged', () => {
  it('rewrites the comment with slice 1 merged', async () => {
    const p = withSliceState(plan(2), 1, 'pr-open', 21, 'factory/5-x');
    const f = fake(renderSlicePlanComment(p));
    const result = await recordSliceMerged({ octokit: f.octokit, ...base, prNumber: 21 });
    expect(result).toEqual({ status: 'recorded', commentId: 77, index: 1 });
    expect(f.updateComment).toHaveBeenCalledTimes(1);
    const arg = f.updateComment.mock.calls[0]?.[0] as { comment_id: number; body: string };
    expect(arg.comment_id).toBe(77);
    const parsed = parseSlicePlanComment(arg.body);
    expect(parsed?.ok && parsed.plan.slices[0]).toMatchObject({ state: 'merged', prNumber: 21, branch: 'factory/5-x' });
    expect(arg.body).toContain('- [x] 1/');
  });

  it('writes nothing for no plan, invalid plan, unknown PR or an already-merged slice', async () => {
    const merged = withSliceState(plan(2), 1, 'merged', 21);
    const pending = withSliceState(plan(2), 1, 'pr-open', 21);
    const cases: [string | undefined, number, string][] = [
      [undefined, 21, 'no-plan'],
      [`${SLICE_PLAN_MARKER}\nno data`, 21, 'invalid'],
      [renderSlicePlanComment(pending), 99, 'no-slice'],
      [renderSlicePlanComment(merged), 21, 'already-merged'],
    ];
    for (const [body, prNumber, status] of cases) {
      const f = fake(body);
      const result = await recordSliceMerged({ octokit: f.octokit, ...base, prNumber });
      expect(result.status).toBe(status);
      expect(f.updateComment).not.toHaveBeenCalled();
    }
  });
});
