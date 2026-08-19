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
  it('plans one slice per scope statement, sharing the context arrays', () => {
    const slices = planSlices(DOC);

    expect(slices).toHaveLength(2);
    expect(slices.map((s) => s.scope.id).sort()).toEqual(['INT-SCOPE-01', 'INT-SCOPE-02']);

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

  const JOURNEY_DOC: IntentDoc = {
    brainDump: 'x',
    statements: [
      statement('INT-PROBLEM-01', 'problem', 'Fulfillment is scattered across tools.'),
      statement('INT-AUDIENCE-01', 'audience', 'the fulfillment team'),
      statement('INT-OUTCOME-01', 'outcome', 'faster fulfillment'),
      // Deliberately NOT in backbone order (access, discover, capture, process, deliver).
      statement('INT-SCOPE-01', 'scope', 'export the finished summary'),
      statement('INT-SCOPE-02', 'scope', 'sign in with sso'),
      statement('INT-SCOPE-03', 'scope', 'add a new record'),
      statement('INT-SCOPE-04', 'scope', 'search for open items'),
      statement('INT-SCOPE-05', 'scope', 'review the pending report'),
      statement('INT-SCOPE-06', 'scope', 'upload another attachment'),
    ],
    gaps: [],
    status: 'approved',
  };

  it('orders slices along the story-map backbone, not raw doc order', () => {
    const slices = planSlices(JOURNEY_DOC);
    const docOrder = JOURNEY_DOC.statements.filter((s) => s.dimension === 'scope').map((s) => s.id);
    const backboneOrder = slices.map((s) => s.scope.id);

    expect(backboneOrder).toEqual([
      'INT-SCOPE-05',
      'INT-SCOPE-02',
      'INT-SCOPE-04',
      'INT-SCOPE-03',
      'INT-SCOPE-06',
      'INT-SCOPE-01',
    ]);
    expect(backboneOrder).not.toEqual(docOrder);
  });

  it('gives every slice a release >= 1 and a step with rank >= 1', () => {
    for (const slice of planSlices(JOURNEY_DOC)) {
      expect(slice.release).toBeGreaterThanOrEqual(1);
      expect(slice.step.rank).toBeGreaterThanOrEqual(1);
    }
  });

  it('flags exactly one walking skeleton, first in the array, at release 1', () => {
    const slices = planSlices(JOURNEY_DOC);
    const skeletons = slices.filter((s) => s.walkingSkeleton);
    expect(skeletons).toHaveLength(1);
    expect(slices[0].walkingSkeleton).toBe(true);
    expect(slices[0].release).toBe(1);
  });

  it('picks the walking skeleton by stage span, beating an earlier-ranked single-stage slice', () => {
    const [skeleton] = planSlices(JOURNEY_DOC);
    // 'review the pending report' spans process + learn; 'sign in with sso' ranks earlier
    // on the backbone (access) but only spans one stage.
    expect(skeleton.scope.id).toBe('INT-SCOPE-05');
  });

  it('groups non-skeleton slices on the same backbone step into one release, releases increasing with rank', () => {
    const slices = planSlices(JOURNEY_DOC);
    const byId = new Map(slices.map((s) => [s.scope.id, s]));

    const capture1 = byId.get('INT-SCOPE-03')!;
    const capture2 = byId.get('INT-SCOPE-06')!;
    expect(capture1.step.stage.id).toBe('capture');
    expect(capture2.step.stage.id).toBe('capture');
    expect(capture1.release).toBe(capture2.release);

    const access = byId.get('INT-SCOPE-02')!;
    const discover = byId.get('INT-SCOPE-04')!;
    const deliver = byId.get('INT-SCOPE-01')!;
    expect(access.release).toBeLessThan(discover.release);
    expect(discover.release).toBeLessThan(capture1.release);
    expect(capture1.release).toBeLessThan(deliver.release);
  });

  it('still shares the doc context arrays on every slice of the journey fixture', () => {
    for (const slice of planSlices(JOURNEY_DOC)) {
      expect(slice.audience.map((s) => s.id)).toEqual(['INT-AUDIENCE-01']);
      expect(slice.outcome.map((s) => s.id)).toEqual(['INT-OUTCOME-01']);
    }
  });

  it('breaks a span-and-step tie in the skeleton comparator by fewest words', () => {
    const doc: IntentDoc = {
      brainDump: 'x',
      statements: [
        statement('INT-PROBLEM-01', 'problem', 'Onboarding is slow.'),
        statement('INT-AUDIENCE-01', 'audience', 'new users'),
        statement('INT-OUTCOME-01', 'outcome', 'faster onboarding'),
        statement('INT-SCOPE-01', 'scope', 'add x'),
        statement('INT-SCOPE-02', 'scope', 'add many extra words to fully describe this task in detail'),
      ],
      gaps: [],
      status: 'approved',
    };

    const [skeleton] = planSlices(doc);
    expect(skeleton.scope.id).toBe('INT-SCOPE-01');
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
