// packages/product/src/decompose/slices.test.ts (#472).

import { describe, expect, it } from 'vitest';

import type { IntentDoc, IntentStatement } from '../intent/index.js';
import { HORIZONTAL_CUES, isVerticalSlice, planSlices } from './slices.js';

function statement(id: string, dimension: IntentStatement['dimension'], text: string): IntentStatement {
  return { id: id as IntentStatement['id'], dimension, text, source: 'answer' };
}

const DOC: IntentDoc = {
  brainDump: 'x',
  statements: [
    statement('INT-PROBLEM-01', 'problem', 'The export breaks weekly.'),
    statement('INT-AUDIENCE-01', 'audience', 'the ops team'),
    statement('INT-OUTCOME-01', 'outcome', 'fewer support tickets'),
    statement('INT-SCOPE-01', 'scope', 'build the retry button'),
    statement('INT-SCOPE-02', 'scope', 'add the retry endpoint'),
    statement('INT-NONGOALS-01', 'nonGoals', 'automated retries'),
    statement('INT-CONSTRAINTS-01', 'constraints', 'must ship before the deadline'),
  ],
  gaps: [],
  status: 'approved',
};

describe('planSlices', () => {
  it('plans one slice per scope statement, in doc order, sharing the context arrays', () => {
    const slices = planSlices(DOC);

    expect(slices).toHaveLength(2);
    expect(slices[0].scope.id).toBe('INT-SCOPE-01');
    expect(slices[1].scope.id).toBe('INT-SCOPE-02');

    for (const slice of slices) {
      expect(slice.audience.map((s) => s.id)).toEqual(['INT-AUDIENCE-01']);
      expect(slice.outcome.map((s) => s.id)).toEqual(['INT-OUTCOME-01']);
      expect(slice.constraints.map((s) => s.id)).toEqual(['INT-CONSTRAINTS-01']);
      expect(slice.nonGoals.map((s) => s.id)).toEqual(['INT-NONGOALS-01']);
    }
  });

  it('returns an empty array for a doc with no scope statements', () => {
    const doc: IntentDoc = { ...DOC, statements: DOC.statements.filter((s) => s.dimension !== 'scope') };
    expect(planSlices(doc)).toEqual([]);
  });
});

describe('isVerticalSlice', () => {
  it('is true for a slice that delivers an outcome and names no horizontal cue', () => {
    const [slice] = planSlices(DOC);
    expect(isVerticalSlice(slice)).toBe(true);
  });

  it('is false when the scope text matches a HORIZONTAL_CUES entry', () => {
    for (const cue of HORIZONTAL_CUES) {
      const doc: IntentDoc = {
        ...DOC,
        statements: [
          ...DOC.statements.filter((s) => s.dimension !== 'scope'),
          statement('INT-SCOPE-01', 'scope', `let's ${cue} the module`),
        ],
      };
      const [slice] = planSlices(doc);
      expect(isVerticalSlice(slice)).toBe(false);
    }
  });

  it('is false when there are no outcome statements', () => {
    const doc: IntentDoc = { ...DOC, statements: DOC.statements.filter((s) => s.dimension !== 'outcome') };
    const [slice] = planSlices(doc);
    expect(isVerticalSlice(slice)).toBe(false);
  });
});
