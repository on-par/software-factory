// packages/product/src/intent/statements.test.ts (#471).

import { describe, expect, it } from 'vitest';

import type { InterviewResult } from '../interview/index.js';
import { extractStatements, splitStatements } from './statements.js';

describe('splitStatements', () => {
  it('splits on newlines', () => {
    expect(splitStatements('first line here\nsecond line here')).toEqual(['first line here', 'second line here']);
  });

  it('splits a line on sentence terminators', () => {
    expect(splitStatements('First sentence. Second sentence! Third sentence?')).toEqual([
      'First sentence.',
      'Second sentence!',
      'Third sentence?',
    ]);
  });

  it('strips a leading bullet or ordered-list marker', () => {
    expect(
      splitStatements('- a dash bullet here\n* a star bullet here\n+ a plus bullet here\n1. a numbered item'),
    ).toEqual(['a dash bullet here', 'a star bullet here', 'a plus bullet here', 'a numbered item']);
  });

  it('trims whitespace and drops fragments shorter than 3 characters', () => {
    expect(splitStatements('  a real fragment here  \nno\n1. yes')).toEqual(['a real fragment here', 'yes']);
  });

  it('returns an empty array for empty input', () => {
    expect(splitStatements('')).toEqual([]);
  });
});

function buildResult(overrides: Partial<InterviewResult>): InterviewResult {
  return {
    brainDump: '',
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

describe('extractStatements', () => {
  it('returns statements in canonical dimension order, tagged source: answer, for a transcript that pinned several dimensions', () => {
    const result = buildResult({
      transcript: [
        {
          question: { index: 1, dimension: 'outcome', text: 'x?' },
          answer: 'Fewer support tickets each week.',
          pinned: true,
        },
        {
          question: { index: 2, dimension: 'problem', text: 'y?' },
          answer: 'The export breaks weekly.',
          pinned: true,
        },
      ],
      gaps: ['audience', 'scope', 'nonGoals', 'constraints'],
    });

    const drafts = extractStatements(result);
    expect(drafts.map((d) => d.dimension)).toEqual(['problem', 'outcome']);
    expect(drafts.every((d) => d.source === 'answer')).toBe(true);
    expect(drafts.find((d) => d.dimension === 'problem')?.text).toBe('The export breaks weekly.');
  });

  it('extracts only brain-dump sentences containing a cue for a dimension covered by the dump', () => {
    const brainDump = 'The manual export process breaks every week. Weather today is fine.';
    const result = buildResult({
      brainDump,
      coveredByDump: ['problem'],
      gaps: ['audience', 'outcome', 'scope', 'nonGoals', 'constraints'],
    });

    const drafts = extractStatements(result);
    expect(drafts).toEqual([
      { dimension: 'problem', text: 'The manual export process breaks every week.', source: 'brain-dump' },
    ]);
  });

  it('collects statements from every pinned exchange of a dimension, including follow-ups, in transcript order', () => {
    const result = buildResult({
      transcript: [
        {
          question: { index: 1, dimension: 'problem', text: 'x?' },
          answer: 'The export breaks weekly.',
          pinned: true,
        },
        {
          question: { index: 2, dimension: 'problem', text: 'y?', followUpDepth: 1 },
          answer: 'It costs an afternoon of manual rework.',
          pinned: true,
        },
      ],
      gaps: ['audience', 'outcome', 'scope', 'nonGoals', 'constraints'],
    });

    const drafts = extractStatements(result);
    expect(drafts).toEqual([
      { dimension: 'problem', text: 'The export breaks weekly.', source: 'answer' },
      { dimension: 'problem', text: 'It costs an afternoon of manual rework.', source: 'answer' },
    ]);
  });

  it('contributes nothing for a declined exchange', () => {
    const result = buildResult({
      transcript: [{ question: { index: 1, dimension: 'problem', text: 'x?' }, answer: "I don't know", pinned: false }],
      gaps: ['problem', 'audience', 'outcome', 'scope', 'nonGoals', 'constraints'],
    });

    expect(extractStatements(result)).toEqual([]);
  });

  it('returns an empty array for an interview with no pinned dimension', () => {
    const result = buildResult({ gaps: ['problem', 'audience', 'outcome', 'scope', 'nonGoals', 'constraints'] });
    expect(extractStatements(result)).toEqual([]);
  });
});
