import { EpicSchema, StorySchema } from '@on-par/contracts';
import type { Story } from '@on-par/contracts';
import { describe, expect, it } from 'vitest';

import type { DecompositionOutput } from './decompose.js';
import {
  SLICE_CAP_CEILING,
  SLICE_PLAN_MARKER,
  currentSlice,
  nextStackSlice,
  parentRefForSlice,
  overCapReason,
  parseSlicePlanComment,
  renderSlicePlanComment,
  sliceCapExceeded,
  slicePlanFromDecomposition,
  withSliceState,
  withSlicesAffected,
  withSlicesNotBuilt,
} from './slice-plan.js';
import type { SlicePlan } from './slice-plan.js';

function story(title: string, extra: Partial<Record<string, unknown>> = {}): Story {
  return StorySchema.parse({
    kind: 'story',
    schemaVersion: 1,
    title,
    role: 'a maintainer',
    want: 'a slice',
    soThat: 'it ships',
    problemStatement: 'the issue is too big',
    inScope: ['one thing'],
    outOfScope: [],
    acceptanceCriteria: [{ name: 'works', given: [], when: ['it runs'], then: ['it passes'] }],
    verification: [{ command: 'npm test', passWhen: 'green' }],
    filesLikelyTouched: [],
    labels: [],
    tracesTo: [],
    ...extra,
  });
}

function decomposition(count: number): DecompositionOutput {
  return {
    epic: EpicSchema.parse({
      kind: 'epic',
      title: 'Epic',
      why: 'because',
      doneWhen: ['done'],
      children: [],
      labels: [],
    }),
    stories: Array.from({ length: count }, (_, i) => story(`Story ${i + 1}`)),
  };
}

function built(count: number): SlicePlan {
  const result = slicePlanFromDecomposition(7, decomposition(count));
  if (!result.ok) throw new Error('expected ok');
  return result.plan;
}

const encode = (value: string): string =>
  `${SLICE_PLAN_MARKER}\n<!-- factory:slice-plan-data ${Buffer.from(value, 'utf8').toString('base64')} -->`;

describe('slicePlanFromDecomposition', () => {
  it.each([1, 10, SLICE_CAP_CEILING])('builds %i pending slices in story order', (count) => {
    const plan = built(count);
    expect(plan.issue).toBe(7);
    expect(plan.slices).toHaveLength(count);
    plan.slices.forEach((s, i) => {
      expect(s.index).toBe(i + 1);
      expect(s.title).toBe(`Story ${i + 1}`);
      expect(s.state).toBe('pending');
      expect('prNumber' in s).toBe(false);
    });
  });

  it('rejects more than the ceiling and empty decompositions', () => {
    expect(slicePlanFromDecomposition(7, decomposition(21))).toEqual({ ok: false, reason: 'over-cap', storyCount: 21 });
    expect(slicePlanFromDecomposition(7, decomposition(0))).toEqual({ ok: false, reason: 'empty', storyCount: 0 });
  });
});

describe('slice cap (ADR-0156)', () => {
  it('round-trips a 20-slice plan and rejects 21 slices', () => {
    const plan = built(20);
    expect(parseSlicePlanComment(renderSlicePlanComment(plan))).toEqual({ ok: true, plan });
    const over = { ...plan, slices: [...plan.slices, { ...plan.slices[0], index: 21 }] };
    expect(parseSlicePlanComment(renderSlicePlanComment(over))).toMatchObject({ ok: false });
  });

  it('sliceCapExceeded only applies while every slice is pending', () => {
    const plan = built(6);
    expect(sliceCapExceeded(plan, 5)).toBe(true);
    expect(sliceCapExceeded(plan, 6)).toBe(false);
    expect(sliceCapExceeded(withSliceState(plan, 1, 'pr-open', 9), 5)).toBe(false);
    expect(sliceCapExceeded(withSliceState(plan, 1, 'merged', 9), 5)).toBe(false);
  });

  it('overCapReason names the count, the cap and the flag', () => {
    const reason = overCapReason(6, 5);
    expect(reason).toContain('6 slices');
    expect(reason).toContain('cap 5');
    expect(reason).toContain('--max-slices 6');
  });
});

describe('renderSlicePlanComment', () => {
  it('leads with the marker and renders one checklist line per slice', () => {
    let plan = withSliceState(built(3), 1, 'merged', 11);
    plan = withSliceState(plan, 2, 'pr-open', 12);
    plan = withSliceState(plan, 3, 'pr-open');
    const out = renderSlicePlanComment(plan);
    expect(out.startsWith(SLICE_PLAN_MARKER)).toBe(true);
    const lines = out.split('\n').filter((l) => l.startsWith('- ['));
    expect(lines).toEqual([
      '- [x] 1/3. Story 1 — merged (#11)',
      '- [ ] 2/3. Story 2 — PR open #12',
      '- [ ] 3/3. Story 3 — PR open',
    ]);
  });

  it('renders pending slices, merged without a PR, and collapses title whitespace', () => {
    const base = built(2);
    const plan: SlicePlan = {
      ...base,
      slices: [
        { ...base.slices[0]!, title: 'a\n  b' },
        { ...base.slices[1]!, state: 'merged' },
      ],
    };
    const lines = renderSlicePlanComment(plan)
      .split('\n')
      .filter((l) => l.startsWith('- ['));
    expect(lines).toEqual(['- [ ] 1/2. a b — pending', '- [x] 2/2. Story 2 — merged']);
  });
});

describe('parseSlicePlanComment', () => {
  it('round-trips awkward story text and mixed states', () => {
    const tricky = 'x --> ``` `x` line1\nline2 — ünï ✓';
    const s1 = story(tricky, {
      want: tricky,
      problemStatement: tricky,
      acceptanceCriteria: [{ name: tricky, given: [], when: [tricky], then: ['ok'] }],
    });
    const plan: SlicePlan = {
      issue: 42,
      slices: [
        { index: 1, title: tricky, story: s1, state: 'merged', prNumber: 5 },
        { index: 2, title: 'two', story: story('two'), state: 'pr-open', prNumber: 6 },
        { index: 3, title: 'three', story: story('three'), state: 'pending' },
      ],
    };
    expect(parseSlicePlanComment(renderSlicePlanComment(plan))).toEqual({ ok: true, plan });
  });

  it('returns null without the marker, even with a data comment', () => {
    expect(parseSlicePlanComment('hello')).toBeNull();
    const withData = renderSlicePlanComment(built(1)).replace(SLICE_PLAN_MARKER, '');
    expect(parseSlicePlanComment(withData)).toBeNull();
  });

  it('reports errors when the marker is present but the data is bad', () => {
    const good = JSON.parse(JSON.stringify(built(2))) as SlicePlan & { slices: Record<string, unknown>[] };
    const withSlices = (slices: unknown[]): string => encode(JSON.stringify({ issue: 7, slices }));
    const six = JSON.parse(JSON.stringify(built(5))) as { slices: unknown[] };
    six.slices.push(six.slices[0]);
    const bodies = [
      SLICE_PLAN_MARKER,
      `${SLICE_PLAN_MARKER}\n<!-- factory:slice-plan-data !!!! -->`,
      encode('not json'),
      withSlices([{ ...good.slices[0], state: 'bogus' }]),
      withSlices([]),
      encode(JSON.stringify(six)),
      withSlices([good.slices[1]]),
    ];
    for (const body of bodies) {
      const result = parseSlicePlanComment(body);
      expect(result).not.toBeNull();
      expect(result).toMatchObject({ ok: false });
      expect((result as { error: string }).error.length).toBeGreaterThan(0);
    }
  });
});

describe('currentSlice', () => {
  it('returns the first non-merged slice, or undefined when all are merged', () => {
    let plan = withSliceState(built(3), 1, 'merged');
    plan = withSliceState(plan, 2, 'pr-open');
    expect(currentSlice(plan)?.index).toBe(2);
    plan = withSliceState(withSliceState(plan, 2, 'merged'), 3, 'merged');
    expect(currentSlice(plan)).toBeUndefined();
  });
});

describe('withSliceState', () => {
  it('returns an updated copy and keeps or replaces the PR number', () => {
    const plan = built(2);
    const opened = withSliceState(plan, 1, 'pr-open', 9);
    expect(plan.slices[0]?.state).toBe('pending');
    expect(opened.slices[0]).toMatchObject({ state: 'pr-open', prNumber: 9 });
    expect(withSliceState(opened, 1, 'merged').slices[0]).toMatchObject({ state: 'merged', prNumber: 9 });
    expect(withSliceState(opened, 1, 'merged', 10).slices[0]?.prNumber).toBe(10);
    expect(opened.slices[1]).toBe(plan.slices[1]);
  });

  it('throws RangeError for an unknown index', () => {
    expect(() => withSliceState(built(1), 2, 'merged')).toThrow(RangeError);
  });
});

describe('withSlicesNotBuilt', () => {
  it('marks slices from k to n not-built and keeps lower slices identical', () => {
    const plan = withSliceState(withSliceState(built(3), 1, 'pr-open', 9, 'b1'), 2, 'pr-open', 10, 'b2');
    const stopped = withSlicesNotBuilt(plan, 2);
    expect(stopped.slices.map((s) => s.state)).toEqual(['pr-open', 'not-built', 'not-built']);
    expect(stopped.slices[0]).toBe(plan.slices[0]);
    expect(stopped.slices[1]).toMatchObject({ prNumber: 10, branch: 'b2' });
    expect(plan.slices[1]?.state).toBe('pr-open');
  });

  it('round-trips through render and parse', () => {
    const stopped = withSlicesNotBuilt(built(3), 2);
    const parsed = parseSlicePlanComment(renderSlicePlanComment(stopped));
    expect(parsed?.ok && parsed.plan.slices.map((s) => s.state)).toEqual(['pending', 'not-built', 'not-built']);
  });

  it('throws RangeError for an unknown index', () => {
    expect(() => withSlicesNotBuilt(built(2), 3)).toThrow(RangeError);
  });
});

describe('withSlicesAffected and headSha', () => {
  const open = () =>
    withSliceState(
      withSliceState(withSliceState(built(3), 1, 'pr-open', 9, 'b1', 'sha1'), 2, 'pr-open', 10, 'b2', 'sha2'),
      3,
      'pr-open',
      11,
      'b3',
      'sha3',
    );

  it('marks only upper pr-open slices as affected', () => {
    const base = withSliceState(open(), 3, 'not-built');
    const { plan, affected } = withSlicesAffected(base, 1);
    expect(affected).toEqual([2]);
    expect(plan.slices.map((s) => s.affectedBy)).toEqual([undefined, 1, undefined]);
  });

  it('throws RangeError for an unknown index', () => {
    expect(() => withSlicesAffected(built(2), 3)).toThrow(RangeError);
  });

  it('records headSha via withSliceState', () => {
    expect(open().slices[0]).toMatchObject({ headSha: 'sha1' });
  });

  it('round-trips headSha and affectedBy and renders the affected note', () => {
    const { plan } = withSlicesAffected(open(), 1);
    const body = renderSlicePlanComment(plan);
    expect(body).toContain('affected by review changes to slice 1');
    const parsed = parseSlicePlanComment(body);
    expect(parsed?.ok && parsed.plan.slices.map((s) => [s.headSha, s.affectedBy])).toEqual([
      ['sha1', undefined],
      ['sha2', 1],
      ['sha3', 1],
    ]);
  });

  it('still parses a comment without the new fields', () => {
    const parsed = parseSlicePlanComment(renderSlicePlanComment(built(2)));
    expect(parsed?.ok && parsed.plan.slices[0]?.headSha).toBeUndefined();
  });
});

describe('stack mode helpers (#3367)', () => {
  const plan3 = (): SlicePlan => ({
    issue: 5,
    slices: [1, 2, 3].map((n) => ({ index: n, title: `S${n}`, story: story(`S${n}`), state: 'pending' as const })),
  });

  it('nextStackSlice returns the lowest pending slice', () => {
    expect(nextStackSlice(plan3())?.index).toBe(1);
    const p = withSliceState(withSliceState(plan3(), 1, 'merged'), 2, 'pr-open', 9);
    expect(nextStackSlice(p)?.index).toBe(3);
    expect(nextStackSlice(withSliceState(p, 3, 'not-built'))).toBeUndefined();
  });

  it('parentRefForSlice returns main for a merged parent and the branch for a pr-open parent', () => {
    const open = withSliceState(plan3(), 1, 'pr-open', 9, 'factory/5-slice-1');
    expect(parentRefForSlice(open, 2)).toBe('factory/5-slice-1');
    expect(parentRefForSlice(withSliceState(open, 1, 'merged'), 2)).toBe('origin/main');
    expect(parentRefForSlice(withSliceState(plan3(), 1, 'merged'), 2, 'main')).toBe('main');
    expect(parentRefForSlice(plan3(), 2)).toBeUndefined();
  });

  it('renders the wait label for a stack slice PR whose next slice is not built', () => {
    const p = withSliceState(plan3(), 1, 'pr-open', 9, 'factory/5-slice-1');
    expect(renderSlicePlanComment(p)).toContain('PR open #9 — waiting for approval or merge before slice 2');
  });

  it('keeps the plain label for a slice-mode branch or once slice k+1 has a branch', () => {
    const sliceMode = withSliceState(plan3(), 1, 'pr-open', 9, 'factory/5-s1-thing');
    expect(renderSlicePlanComment(sliceMode)).not.toContain('waiting for approval');
    const started = withSliceState(
      withSliceState(plan3(), 1, 'pr-open', 9, 'factory/5-slice-1'),
      2,
      'pr-open',
      10,
      'factory/5-slice-2',
    );
    expect(renderSlicePlanComment(started)).not.toContain('PR open #9 — waiting');
  });
});
