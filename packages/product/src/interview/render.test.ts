// packages/product/src/interview/render.test.ts (#470).

import { describe, expect, it } from 'vitest';

import type { InterviewResult } from './interview.js';
import { renderInterviewSummary } from './render.js';

function baseResult(overrides: Partial<InterviewResult> = {}): InterviewResult {
  return {
    brainDump: 'dump',
    coveredByDump: [],
    transcript: [],
    pinned: [],
    gaps: [],
    stopReason: 'pinned',
    questionsAsked: 0,
    questionBudget: 6,
    ...overrides,
  };
}

describe('renderInterviewSummary', () => {
  it('renders a pinned result with no open gaps', () => {
    const result = baseResult({
      pinned: ['problem', 'audience', 'outcome', 'scope', 'nonGoals', 'constraints'],
      questionsAsked: 3,
      stopReason: 'pinned',
    });
    const lines = renderInterviewSummary(result);
    expect(lines[0]).toBe('Asked 3 of 6 question(s); stopped: pinned');
    expect(lines[1]).toBe('Pinned: problem, audience, outcome, scope, nonGoals, constraints');
    expect(lines[2]).toBe('Open gaps: (none)');
  });

  it('renders an all-gaps result with no pinned dimensions', () => {
    const result = baseResult({
      gaps: ['problem', 'audience', 'outcome', 'scope', 'nonGoals', 'constraints'],
      questionsAsked: 0,
      questionBudget: 0,
      stopReason: 'budget-exhausted',
    });
    const lines = renderInterviewSummary(result);
    expect(lines[0]).toBe('Asked 0 of 0 question(s); stopped: budget-exhausted');
    expect(lines[1]).toBe('Pinned: (none)');
    expect(lines[2]).toBe('Open gaps: problem, audience, outcome, scope, nonGoals, constraints');
  });
});
