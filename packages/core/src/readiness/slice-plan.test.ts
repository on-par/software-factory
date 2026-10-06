import { EpicSchema, StorySchema } from '@on-par/contracts';
import type { Story } from '@on-par/contracts';
import { describe, expect, it } from 'vitest';

import type { DecompositionOutput } from './decompose.js';
import {
  MAX_SLICES,
  SLICE_PLAN_MARKER,
  currentSlice,
  parseSlicePlanComment,
  renderSlicePlanComment,
  slicePlanFromDecomposition,
  withSliceState,
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
  it.each([1, MAX_SLICES])('builds %i pending slices in story order', (count) => {
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

  it('rejects more than the cap and empty decompositions', () => {
    expect(slicePlanFromDecomposition(7, decomposition(6))).toEqual({ ok: false, reason: 'over-cap', storyCount: 6 });
    expect(slicePlanFromDecomposition(7, decomposition(0))).toEqual({ ok: false, reason: 'empty', storyCount: 0 });
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
