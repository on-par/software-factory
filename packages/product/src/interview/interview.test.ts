// packages/product/src/interview/interview.test.ts (#470).

import { describe, expect, it, vi } from 'vitest';

import { INTENT_DIMENSIONS } from './dimensions.js';
import type { InterviewDeps, InterviewQuestion } from './interview.js';
import { DEFAULT_QUESTION_BUDGET, formatQuestion, runInterview } from './interview.js';

const SPARSE_DUMP = 'The manual export process breaks every week and wastes an afternoon.';
const NEUTRAL_DUMP = 'Nothing notable to report right now.';
const FULL_DUMP =
  'The manual export process breaks every week and wastes an afternoon, as a user on the ops team ' +
  'we need this so that we reduce the manual toil; build the smallest slice, but out of scope for now is ' +
  'automated retries, and this must ship before the deadline given the legacy platform constraint.';

function scriptedAsk(answers: Record<string, string>): InterviewDeps['ask'] {
  return vi.fn(async (question: InterviewQuestion) => answers[question.dimension] ?? 'a substantive answer here');
}

describe('runInterview', () => {
  it('clarifies until pinned: asks only uncovered dimensions, never repeats, and ends pinned', async () => {
    const ask = scriptedAsk({});
    const result = await runInterview(SPARSE_DUMP, { ask });

    const askedDimensions = result.transcript.map((exchange) => exchange.question.dimension);
    expect(new Set(askedDimensions).size).toBe(askedDimensions.length);
    for (const dimension of askedDimensions) {
      expect(result.coveredByDump).not.toContain(dimension);
    }
    expect(result.stopReason).toBe('pinned');
    expect(result.gaps).toEqual([]);
  });

  it('stops on a bounded budget with gaps remaining', async () => {
    const ask = scriptedAsk({});
    const result = await runInterview(SPARSE_DUMP, { ask }, { questionBudget: 2 });

    expect(result.questionsAsked).toBe(2);
    expect(result.stopReason).toBe('budget-exhausted');
    expect(result.gaps.length).toBeGreaterThan(0);
  });

  it('asks nothing and stops budget-exhausted when the budget is 0', async () => {
    const ask = scriptedAsk({});
    const result = await runInterview(SPARSE_DUMP, { ask }, { questionBudget: 0 });

    expect(ask).not.toHaveBeenCalled();
    expect(result.stopReason).toBe('budget-exhausted');
  });

  it('asks nothing and stops pinned when the dump already covers all six dimensions', async () => {
    const ask = scriptedAsk({});
    const result = await runInterview(FULL_DUMP, { ask });

    expect(ask).not.toHaveBeenCalled();
    expect(result.questionsAsked).toBe(0);
    expect(result.stopReason).toBe('pinned');
    expect(result.coveredByDump).toEqual(INTENT_DIMENSIONS);
  });

  it('leaves declined dimensions in gaps, asked exactly once, stopping no-questions-left', async () => {
    const ask = vi.fn(async () => "I don't know");
    const result = await runInterview(SPARSE_DUMP, { ask });

    const askedDimensions = result.transcript.map((exchange) => exchange.question.dimension);
    expect(new Set(askedDimensions).size).toBe(askedDimensions.length);
    expect(result.stopReason).toBe('no-questions-left');
    for (const exchange of result.transcript) {
      expect(exchange.pinned).toBe(false);
      expect(result.gaps).toContain(exchange.question.dimension);
    }
  });

  it('partitions pinned and gaps in canonical order for a mixed run', async () => {
    let call = 0;
    const ask = vi.fn(async () => {
      call += 1;
      return call % 2 === 0 ? 'n/a' : 'a substantive answer here';
    });
    const result = await runInterview(SPARSE_DUMP, { ask });

    const all = new Set([...result.pinned, ...result.gaps]);
    expect(all.size).toBe(INTENT_DIMENSIONS.length);
    expect(result.gaps.length).toBeGreaterThan(0);
    expect(result.pinned.length).toBeGreaterThan(0);
    expect(result.pinned).toEqual(INTENT_DIMENSIONS.filter((d) => result.pinned.includes(d)));
    expect(result.gaps).toEqual(INTENT_DIMENSIONS.filter((d) => result.gaps.includes(d)));
  });

  it('assigns a 1-based index that increments by one across the transcript', async () => {
    const ask = scriptedAsk({});
    const result = await runInterview(SPARSE_DUMP, { ask });

    result.transcript.forEach((exchange, i) => {
      expect(exchange.question.index).toBe(i + 1);
    });
  });

  it('uses a synchronous phraseQuestion override, falling back on blank output', async () => {
    const ask = scriptedAsk({});
    const seen: Array<[string, string]> = [];
    const phraseQuestion = vi.fn((probe, brainDump: string) => {
      seen.push([probe.dimension, brainDump]);
      return probe.dimension === 'problem' ? 'Custom ask?' : '   ';
    });
    const result = await runInterview(NEUTRAL_DUMP, { ask, phraseQuestion });

    const problemQuestion = result.transcript.find((e) => e.question.dimension === 'problem');
    expect(problemQuestion?.question.text).toBe('Custom ask?');
    const otherQuestion = result.transcript.find((e) => e.question.dimension !== 'problem');
    expect(otherQuestion?.question.text).not.toBe('');
    expect(seen.every(([, dump]) => dump === NEUTRAL_DUMP)).toBe(true);
  });

  it('uses an async phraseQuestion override', async () => {
    const ask = scriptedAsk({});
    const phraseQuestion = vi.fn(async (probe) => (probe.dimension === 'problem' ? 'Custom async ask?' : ''));
    const result = await runInterview(NEUTRAL_DUMP, { ask, phraseQuestion });

    const problemQuestion = result.transcript.find((e) => e.question.dimension === 'problem');
    expect(problemQuestion?.question.text).toBe('Custom async ask?');
  });

  it('normalizes a negative budget to 0', async () => {
    const ask = scriptedAsk({});
    const result = await runInterview(SPARSE_DUMP, { ask }, { questionBudget: -3 });

    expect(ask).not.toHaveBeenCalled();
    expect(result.questionBudget).toBe(0);
    expect(result.stopReason).toBe('budget-exhausted');
  });

  it('truncates a fractional budget', async () => {
    const ask = scriptedAsk({});
    const result = await runInterview(SPARSE_DUMP, { ask }, { questionBudget: 2.9 });

    expect(result.questionBudget).toBe(2);
    expect(result.questionsAsked).toBe(2);
  });

  it('defaults the budget to one pass over the dimension list', async () => {
    const ask = scriptedAsk({});
    const result = await runInterview(SPARSE_DUMP, { ask });

    expect(result.questionBudget).toBe(DEFAULT_QUESTION_BUDGET);
  });
});

describe('formatQuestion', () => {
  it('formats the index, label, and question text', () => {
    expect(formatQuestion({ index: 1, dimension: 'problem', text: 'X?' })).toBe('Q1 [Problem] X?');
  });
});
