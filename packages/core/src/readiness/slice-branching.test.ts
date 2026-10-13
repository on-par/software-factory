import { EpicSchema, StorySchema } from '@on-par/contracts';
import type { Story } from '@on-par/contracts';
import { describe, expect, it } from 'vitest';

import { designSmellsChecker, workerOutputChecker } from '../checkers/design-smells.js';
import type { DecompositionOutput } from './decompose.js';
import {
  parentRefForSlice,
  parseSlicePlanComment,
  renderSlicePlanComment,
  slicePlanFromDecomposition,
  stackSliceBranch,
  withSliceBranchCreated,
  withSliceState,
} from './slice-plan.js';
import type { SlicePlan } from './slice-plan.js';

function story(title: string): Story {
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
  });
}

function freshPlan(count: number): SlicePlan {
  const decomposition: DecompositionOutput = {
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
  const result = slicePlanFromDecomposition(2702, decomposition);
  if (!result.ok) throw new Error('expected ok');
  return result.plan;
}

describe('stackSliceBranch', () => {
  it('returns a deterministic factory/<issue>-slice-<index> name', () => {
    expect(stackSliceBranch(2702, 1)).toBe('factory/2702-slice-1');
    expect(stackSliceBranch(2702, 3)).toBe(stackSliceBranch(2702, 3));
    expect(stackSliceBranch(2702, 3)).toBe('factory/2702-slice-3');
  });
});

describe('parentRefForSlice', () => {
  it('returns origin/main for slice 1', () => {
    const plan = withSliceState(freshPlan(3), 1, 'pr-open', 11, stackSliceBranch(2702, 1));
    expect(parentRefForSlice(freshPlan(3), 1)).toBe('origin/main');
    expect(parentRefForSlice(plan, 1)).toBe('origin/main');
    expect(parentRefForSlice(plan, 1, 'origin/develop')).toBe('origin/develop');
  });

  it("returns the previous slice's recorded branch for slices 2 and 3", () => {
    let plan = withSliceState(freshPlan(3), 1, 'pr-open', 11, stackSliceBranch(2702, 1));
    plan = withSliceState(plan, 2, 'pr-open', 12, stackSliceBranch(2702, 2));
    expect(parentRefForSlice(plan, 2)).toBe('factory/2702-slice-1');
    expect(parentRefForSlice(plan, 3)).toBe('factory/2702-slice-2');
  });

  it('returns undefined when the previous slice has no recorded branch', () => {
    expect(parentRefForSlice(freshPlan(3), 2)).toBeUndefined();
  });

  it('returns undefined for an index outside the plan', () => {
    const plan = freshPlan(3);
    for (const index of [0, -1, 1.5, plan.slices.length + 1]) {
      expect(parentRefForSlice(plan, index)).toBeUndefined();
    }
  });
});

describe('withSliceBranchCreated', () => {
  it('records the slice branch in the plan comment on creation', () => {
    const plan = withSliceBranchCreated(freshPlan(3), 1);
    expect(plan.slices[0]?.branch).toBe('factory/2702-slice-1');
    const body = renderSlicePlanComment(plan);
    expect(body).toContain('branch `factory/2702-slice-1`');
    const parsed = parseSlicePlanComment(body);
    expect(parsed?.ok).toBe(true);
    if (parsed?.ok) expect(parsed.plan.slices[0]?.branch).toBe('factory/2702-slice-1');
  });

  it('keeps the slice pending when the plan is read back', () => {
    const parsed = parseSlicePlanComment(renderSlicePlanComment(withSliceBranchCreated(freshPlan(3), 2)));
    expect(parsed?.ok).toBe(true);
    if (!parsed?.ok) return;
    expect(parsed.plan.slices.map((s) => s.state)).toEqual(['pending', 'pending', 'pending']);
    expect(parsed.plan.slices[1]?.prNumber).toBeUndefined();
    expect(parsed.plan.slices[1]?.headSha).toBeUndefined();
  });

  it('lets parentRefForSlice resolve the next slice before SHIP', () => {
    const fresh = freshPlan(3);
    expect(parentRefForSlice(fresh, 2)).toBeUndefined();
    const plan = withSliceBranchCreated(fresh, 1);
    expect(parentRefForSlice(plan, 2)).toBe('factory/2702-slice-1');
  });

  it('records an explicit branch and leaves other slices and an existing state untouched', () => {
    const before = withSliceState(freshPlan(3), 1, 'pr-open', 11);
    const snapshot = structuredClone(before);
    const plan = withSliceBranchCreated(before, 1, 'factory/custom');
    expect(plan.slices[0]).toMatchObject({ state: 'pr-open', prNumber: 11, branch: 'factory/custom' });
    expect(plan.slices[1]).toEqual(before.slices[1]);
    expect(plan.slices[2]).toEqual(before.slices[2]);
    expect(before).toEqual(snapshot);
  });

  it('throws for an index outside the plan', () => {
    const plan = freshPlan(3);
    expect(() => withSliceBranchCreated(plan, 0)).toThrow(RangeError);
    expect(() => withSliceBranchCreated(plan, 4)).toThrow(RangeError);
  });
});

describe('CHECK diff base', () => {
  it('CHECK diff base: workerOutputChecker and designSmellsChecker diff against the slice parent ref', async () => {
    const plan = withSliceBranchCreated(freshPlan(3), 1);
    const ref = parentRefForSlice(plan, 2);
    expect(ref).toBe('factory/2702-slice-1');
    const seen: (string | undefined)[] = [];
    const collectDiff = (async (_w: string, _n: unknown, opts?: { baseRefOverride?: string }) => {
      seen.push(opts?.baseRefOverride);
      return { text: '', baseRef: ref, truncated: false };
    }) as any;
    const ctx = { worktree: '/w', specPath: '/w/spec.md', parentBaseRef: ref };
    await workerOutputChecker(ctx, { collectDiff });
    await designSmellsChecker(ctx, {} as any, undefined, { collectDiff, env: {} });
    expect(seen).toEqual([ref, ref]);
  });
});
