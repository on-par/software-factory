// packages/product/src/intent/intent-doc.test.ts (#471).

import { INTENT_STATEMENT_ID_PATTERN } from '@on-par/contracts';
import { describe, expect, it } from 'vitest';

import type { InterviewResult } from '../interview/index.js';
import { approveIntentDoc, buildIntentDoc } from './intent-doc.js';

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

const PINNED_RESULT = buildResult({
  transcript: [
    {
      question: { index: 1, dimension: 'problem', text: 'x?' },
      answer: 'The export breaks weekly. It wastes an afternoon each time.',
      pinned: true,
    },
    {
      question: { index: 2, dimension: 'outcome', text: 'y?' },
      answer: 'Fewer support tickets each week.',
      pinned: true,
    },
  ],
  gaps: [],
});

describe('buildIntentDoc', () => {
  it('Gherkin: approved intent doc with stable IDs — every statement has a unique, well-formed ID with per-dimension ordinals in extraction order', () => {
    const doc = buildIntentDoc(PINNED_RESULT);

    for (const statement of doc.statements) {
      expect(INTENT_STATEMENT_ID_PATTERN.test(statement.id)).toBe(true);
    }
    expect(new Set(doc.statements.map((s) => s.id)).size).toBe(doc.statements.length);

    const problemIds = doc.statements.filter((s) => s.dimension === 'problem').map((s) => s.id);
    expect(problemIds).toEqual(['INT-PROBLEM-01', 'INT-PROBLEM-02']);
  });

  it('produces a deep-equal doc — same IDs — when rebuilt from the same InterviewResult', () => {
    expect(buildIntentDoc(PINNED_RESULT)).toEqual(buildIntentDoc(PINNED_RESULT));
  });

  it('is status: draft with approvedBy undefined for a freshly built doc', () => {
    const doc = buildIntentDoc(PINNED_RESULT);
    expect(doc.status).toBe('draft');
    expect(doc.approvedBy).toBeUndefined();
  });
});

describe('approveIntentDoc', () => {
  it('approves a pinned doc, returning a new doc and leaving the input unchanged', () => {
    const doc = buildIntentDoc(PINNED_RESULT);
    const result = approveIntentDoc(doc, 'Pat');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.doc.status).toBe('approved');
      expect(result.doc.approvedBy).toBe('Pat');
    }
    expect(doc.status).toBe('draft');
  });

  it('blocks on a blank approver', () => {
    const doc = buildIntentDoc(PINNED_RESULT);
    const result = approveIntentDoc(doc, '   ');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.blockers).toContain('approval needs a named approver');
    }
  });

  it('blocks on a doc with zero statements', () => {
    const doc = buildIntentDoc(buildResult({ gaps: [] }));
    const result = approveIntentDoc(doc, 'Pat');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.blockers).toContain('the intent doc has no statements');
    }
  });

  it('blocks on a doc with open gaps, naming the gap dimensions', () => {
    const doc = buildIntentDoc(
      buildResult({
        transcript: PINNED_RESULT.transcript,
        gaps: ['audience', 'scope'],
      }),
    );
    const result = approveIntentDoc(doc, 'Pat');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.blockers).toContain('intent is not pinned: audience, scope');
    }
  });
});
