// packages/product/src/judge/rubric.test.ts (#474).

import { CONTRACTS_SCHEMA_VERSION, type Story } from '@on-par/contracts';
import { describe, expect, it } from 'vitest';

import type { IntentDoc } from '../intent/index.js';
import { judgeStory } from './loop.js';
import { judgeStoryAgainstIntent, reworkStoryMechanically } from './rubric.js';

const DOC: IntentDoc = {
  brainDump: 'The manual export process breaks every week.',
  statements: [
    { id: 'INT-PROBLEM-01', dimension: 'problem', text: 'The export breaks weekly', source: 'answer' },
    { id: 'INT-AUDIENCE-01', dimension: 'audience', text: 'The ops team is affected', source: 'answer' },
    { id: 'INT-OUTCOME-01', dimension: 'outcome', text: 'Fewer support tickets are filed', source: 'answer' },
    { id: 'INT-SCOPE-01', dimension: 'scope', text: 'Build the retry button', source: 'answer' },
    { id: 'INT-NONGOALS-01', dimension: 'nonGoals', text: 'Automated retries are out of scope', source: 'answer' },
    { id: 'INT-CONSTRAINTS-01', dimension: 'constraints', text: 'Ship before the deadline', source: 'answer' },
  ],
  gaps: [],
  status: 'approved',
  approvedBy: 'Pat',
};

const CLEAN_STORY: Story = {
  schemaVersion: CONTRACTS_SCHEMA_VERSION,
  kind: 'story',
  title: 'Build the retry button',
  role: 'ops team member',
  want: 'a retry button',
  soThat: 'fewer support tickets are filed',
  problemStatement: 'The export breaks weekly',
  inScope: ['Build the retry button'],
  outOfScope: ['Automated retries are out of scope'],
  acceptanceCriteria: [
    {
      name: 'Outcome: Fewer support tickets are filed',
      given: ['The ops team is affected', 'Ship before the deadline'],
      when: ['Build the retry button'],
      then: ['Fewer support tickets are filed'],
      tracesTo: ['INT-AUDIENCE-01', 'INT-CONSTRAINTS-01', 'INT-SCOPE-01', 'INT-OUTCOME-01'],
    },
  ],
  verification: [
    { command: 'manual: confirm Fewer support tickets are filed', passWhen: 'Fewer support tickets are filed' },
  ],
  filesLikelyTouched: [],
  labels: [],
  tracesTo: ['INT-SCOPE-01', 'INT-AUDIENCE-01', 'INT-OUTCOME-01'],
};

describe('judgeStoryAgainstIntent', () => {
  it('scores a clean decomposed story 100 with "All 6 checks passed."', () => {
    const verdict = judgeStoryAgainstIntent(CLEAN_STORY, DOC);
    expect(verdict.score).toBe(100);
    expect(verdict.rationale).toBe('All 6 checks passed.');
    expect(verdict.checks).toHaveLength(6);
    expect(verdict.checks.every((c) => c.passed)).toBe(true);
  });

  it('fails traces-resolve on a bogus tracesTo id, lowering the score and naming the offender', () => {
    const story = { ...CLEAN_STORY, tracesTo: [...CLEAN_STORY.tracesTo, 'INT-BOGUS-01'] };
    const verdict = judgeStoryAgainstIntent(story, DOC);
    const check = verdict.checks.find((c) => c.id === 'traces-resolve')!;
    expect(check.passed).toBe(false);
    expect(check.note).toContain('INT-BOGUS-01');
    expect(verdict.score).toBeLessThan(100);
  });

  it('fails traces-resolve on a bogus acceptance-criterion tracesTo id', () => {
    const story = {
      ...CLEAN_STORY,
      acceptanceCriteria: [{ ...CLEAN_STORY.acceptanceCriteria[0]!, tracesTo: ['INT-BOGUS-02'] }],
    };
    const verdict = judgeStoryAgainstIntent(story, DOC);
    const check = verdict.checks.find((c) => c.id === 'traces-resolve')!;
    expect(check.passed).toBe(false);
    expect(check.note).toContain('INT-BOGUS-02');
  });

  it('fails cites-scope when tracesTo has no scope-dimension id', () => {
    const story = { ...CLEAN_STORY, tracesTo: CLEAN_STORY.tracesTo.filter((id) => id !== 'INT-SCOPE-01') };
    const verdict = judgeStoryAgainstIntent(story, DOC);
    const check = verdict.checks.find((c) => c.id === 'cites-scope')!;
    expect(check.passed).toBe(false);
    expect(verdict.score).toBeLessThan(100);
  });

  it('fails cites-outcome when tracesTo has no outcome-dimension id', () => {
    const story = { ...CLEAN_STORY, tracesTo: CLEAN_STORY.tracesTo.filter((id) => id !== 'INT-OUTCOME-01') };
    const verdict = judgeStoryAgainstIntent(story, DOC);
    const check = verdict.checks.find((c) => c.id === 'cites-outcome')!;
    expect(check.passed).toBe(false);
  });

  it('fails invest-clean on an INVEST-violating story, joining violations as "letter: reason"', () => {
    const story = { ...CLEAN_STORY, want: 'a retry button that depends on the export job' };
    const verdict = judgeStoryAgainstIntent(story, DOC);
    const check = verdict.checks.find((c) => c.id === 'invest-clean')!;
    expect(check.passed).toBe(false);
    expect(check.note).toMatch(/^independent: /);
  });

  it('fails non-goals-captured when the doc names non-goals but the story carries none', () => {
    const story = { ...CLEAN_STORY, outOfScope: [] };
    const verdict = judgeStoryAgainstIntent(story, DOC);
    const check = verdict.checks.find((c) => c.id === 'non-goals-captured')!;
    expect(check.passed).toBe(false);
  });

  it('passes non-goals-captured trivially when the doc names no non-goals at all', () => {
    const docWithoutNonGoals = { ...DOC, statements: DOC.statements.filter((s) => s.dimension !== 'nonGoals') };
    const story = { ...CLEAN_STORY, outOfScope: [] };
    const verdict = judgeStoryAgainstIntent(story, docWithoutNonGoals);
    const check = verdict.checks.find((c) => c.id === 'non-goals-captured')!;
    expect(check.passed).toBe(true);
  });

  it('fails criteria-trace when an acceptance criterion has no tracesTo', () => {
    const story = {
      ...CLEAN_STORY,
      acceptanceCriteria: [{ ...CLEAN_STORY.acceptanceCriteria[0]!, tracesTo: [] }],
    };
    const verdict = judgeStoryAgainstIntent(story, DOC);
    const check = verdict.checks.find((c) => c.id === 'criteria-trace')!;
    expect(check.passed).toBe(false);
    expect(check.note).toContain(story.acceptanceCriteria[0]!.name);
  });

  it('is deterministic — two calls on the same story and doc are deep-equal', () => {
    expect(judgeStoryAgainstIntent(CLEAN_STORY, DOC)).toEqual(judgeStoryAgainstIntent(CLEAN_STORY, DOC));
  });
});

describe('reworkStoryMechanically', () => {
  it('fixes traces-resolve by filtering unresolved ids out of tracesTo and every criterion', () => {
    const story = {
      ...CLEAN_STORY,
      tracesTo: [...CLEAN_STORY.tracesTo, 'INT-BOGUS-01'],
      acceptanceCriteria: [
        {
          ...CLEAN_STORY.acceptanceCriteria[0]!,
          tracesTo: [...CLEAN_STORY.acceptanceCriteria[0]!.tracesTo, 'INT-BOGUS-02'],
        },
      ],
    };
    const verdict = judgeStoryAgainstIntent(story, DOC);
    const reworked = reworkStoryMechanically(story, verdict, DOC);

    expect(reworked.tracesTo).not.toContain('INT-BOGUS-01');
    expect(reworked.acceptanceCriteria[0]!.tracesTo).not.toContain('INT-BOGUS-02');
    expect(judgeStoryAgainstIntent(reworked, DOC).checks.find((c) => c.id === 'traces-resolve')!.passed).toBe(true);
  });

  it("fixes cites-scope by appending the doc's first scope statement id", () => {
    const story = { ...CLEAN_STORY, tracesTo: CLEAN_STORY.tracesTo.filter((id) => id !== 'INT-SCOPE-01') };
    const verdict = judgeStoryAgainstIntent(story, DOC);
    const reworked = reworkStoryMechanically(story, verdict, DOC);

    expect(reworked.tracesTo).toContain('INT-SCOPE-01');
    expect(judgeStoryAgainstIntent(reworked, DOC).checks.find((c) => c.id === 'cites-scope')!.passed).toBe(true);
  });

  it("fixes cites-outcome by appending the doc's first outcome statement id", () => {
    const story = { ...CLEAN_STORY, tracesTo: CLEAN_STORY.tracesTo.filter((id) => id !== 'INT-OUTCOME-01') };
    const verdict = judgeStoryAgainstIntent(story, DOC);
    const reworked = reworkStoryMechanically(story, verdict, DOC);

    expect(reworked.tracesTo).toContain('INT-OUTCOME-01');
    expect(judgeStoryAgainstIntent(reworked, DOC).checks.find((c) => c.id === 'cites-outcome')!.passed).toBe(true);
  });

  it('leaves cites-scope unfixed when the doc has no scope statement to cite', () => {
    const docWithoutScope: IntentDoc = { ...DOC, statements: DOC.statements.filter((s) => s.dimension !== 'scope') };
    const story = {
      ...CLEAN_STORY,
      tracesTo: CLEAN_STORY.tracesTo.filter((id) => id !== 'INT-SCOPE-01'),
      acceptanceCriteria: [
        {
          ...CLEAN_STORY.acceptanceCriteria[0]!,
          tracesTo: CLEAN_STORY.acceptanceCriteria[0]!.tracesTo.filter((id) => id !== 'INT-SCOPE-01'),
        },
      ],
    };
    const verdict = judgeStoryAgainstIntent(story, docWithoutScope);
    expect(verdict.checks.find((c) => c.id === 'cites-scope')!.passed).toBe(false);

    const reworked = reworkStoryMechanically(story, verdict, docWithoutScope);
    expect(reworked).toBe(story);
  });

  it('leaves cites-outcome unfixed when the doc has no outcome statement to cite', () => {
    const docWithoutOutcome: IntentDoc = {
      ...DOC,
      statements: DOC.statements.filter((s) => s.dimension !== 'outcome'),
    };
    const story = {
      ...CLEAN_STORY,
      tracesTo: CLEAN_STORY.tracesTo.filter((id) => id !== 'INT-OUTCOME-01'),
      acceptanceCriteria: [
        {
          ...CLEAN_STORY.acceptanceCriteria[0]!,
          tracesTo: CLEAN_STORY.acceptanceCriteria[0]!.tracesTo.filter((id) => id !== 'INT-OUTCOME-01'),
        },
      ],
    };
    const verdict = judgeStoryAgainstIntent(story, docWithoutOutcome);
    expect(verdict.checks.find((c) => c.id === 'cites-outcome')!.passed).toBe(false);

    const reworked = reworkStoryMechanically(story, verdict, docWithoutOutcome);
    expect(reworked).toBe(story);
  });

  it("fixes non-goals-captured by setting outOfScope to the doc's non-goal texts", () => {
    const story = { ...CLEAN_STORY, outOfScope: [] };
    const verdict = judgeStoryAgainstIntent(story, DOC);
    const reworked = reworkStoryMechanically(story, verdict, DOC);

    expect(reworked.outOfScope).toEqual(['Automated retries are out of scope']);
  });

  it('fixes criteria-trace by setting empty-tracesTo criteria to the (fixed) story-level tracesTo', () => {
    const story = {
      ...CLEAN_STORY,
      acceptanceCriteria: [{ ...CLEAN_STORY.acceptanceCriteria[0]!, tracesTo: [] }],
    };
    const verdict = judgeStoryAgainstIntent(story, DOC);
    const reworked = reworkStoryMechanically(story, verdict, DOC);

    expect(reworked.acceptanceCriteria[0]!.tracesTo).toEqual(reworked.tracesTo);
  });

  it('only sets tracesTo on criteria that were empty, leaving already-traced criteria alone', () => {
    const populatedCriterion = CLEAN_STORY.acceptanceCriteria[0]!;
    const emptyCriterion = { ...populatedCriterion, name: 'Second criterion', tracesTo: [] };
    const story = { ...CLEAN_STORY, acceptanceCriteria: [populatedCriterion, emptyCriterion] };
    const verdict = judgeStoryAgainstIntent(story, DOC);

    const reworked = reworkStoryMechanically(story, verdict, DOC);

    expect(reworked.acceptanceCriteria[0]).toEqual(populatedCriterion);
    expect(reworked.acceptanceCriteria[1]!.tracesTo).toEqual(reworked.tracesTo);
  });

  it('does not mutate its input story', () => {
    const story = { ...CLEAN_STORY, outOfScope: [] };
    const snapshot = JSON.parse(JSON.stringify(story));
    const verdict = judgeStoryAgainstIntent(story, DOC);

    reworkStoryMechanically(story, verdict, DOC);

    expect(story).toEqual(snapshot);
  });

  it('returns the story unchanged when every check already passes', () => {
    const verdict = judgeStoryAgainstIntent(CLEAN_STORY, DOC);
    const reworked = reworkStoryMechanically(CLEAN_STORY, verdict, DOC);

    expect(reworked).toBe(CLEAN_STORY);
  });

  it('returns the story unchanged when only the unfixable invest-clean check fails', () => {
    const story = { ...CLEAN_STORY, want: 'a retry button that depends on the export job' };
    const verdict = judgeStoryAgainstIntent(story, DOC);

    const reworked = reworkStoryMechanically(story, verdict, DOC);

    expect(reworked).toBe(story);
  });

  it('converges to passed through judgeStory with default deps when only fixable checks fail', async () => {
    const story = {
      ...CLEAN_STORY,
      tracesTo: CLEAN_STORY.tracesTo.filter((id) => id !== 'INT-SCOPE-01'),
      outOfScope: [],
      acceptanceCriteria: [{ ...CLEAN_STORY.acceptanceCriteria[0]!, tracesTo: [] }],
    };

    const judged = await judgeStory(story, DOC);

    expect(judged.stopReason).toBe('passed');
    expect(judged.verdict.score).toBe(100);
  });
});
