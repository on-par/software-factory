import { EpicSchema, StorySchema } from '@on-par/contracts';
import type { Story } from '@on-par/contracts';
import { describe, expect, it } from 'vitest';

import type { DecompositionOutput } from './decompose.js';
import { parentRefForSlice, slicePlanFromDecomposition, stackSliceBranch, withSliceState } from './slice-plan.js';
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
