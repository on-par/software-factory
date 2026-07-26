import { describe, expect, it } from 'vitest';

import {
  formatIntentStatementId,
  INTENT_STATEMENT_ID_PATTERN,
  IntentStatementIdSchema,
  isIntentStatementId,
  TracesToSchema,
} from './trace.js';

describe('formatIntentStatementId', () => {
  it('mints INT-<DIMENSION>-<NN> from a dimension name and a 1-based ordinal', () => {
    expect(formatIntentStatementId('problem', 1)).toBe('INT-PROBLEM-01');
    expect(formatIntentStatementId('nonGoals', 12)).toBe('INT-NONGOALS-12');
  });

  it('widens past 99 rather than wrapping, and still matches the pattern', () => {
    const id = formatIntentStatementId('problem', 100);
    expect(id).toBe('INT-PROBLEM-100');
    expect(INTENT_STATEMENT_ID_PATTERN.test(id)).toBe(true);
  });

  it('clamps a zero or negative ordinal to 01', () => {
    expect(formatIntentStatementId('problem', 0)).toBe('INT-PROBLEM-01');
    expect(formatIntentStatementId('problem', -3)).toBe('INT-PROBLEM-01');
  });

  it('truncates a fractional ordinal', () => {
    expect(formatIntentStatementId('problem', 2.9)).toBe('INT-PROBLEM-02');
  });
});

describe('IntentStatementIdSchema', () => {
  it('round-trips a well-formed ID', () => {
    expect(IntentStatementIdSchema.parse('INT-SCOPE-01')).toBe('INT-SCOPE-01');
  });

  it('rejects a value with no INT- prefix', () => {
    expect(() => IntentStatementIdSchema.parse('nope')).toThrow();
  });

  it('rejects a lower-cased dimension', () => {
    expect(() => IntentStatementIdSchema.parse('INT-scope-01')).toThrow();
  });

  it('rejects a single-digit ordinal', () => {
    expect(() => IntentStatementIdSchema.parse('INT-SCOPE-1')).toThrow();
  });
});

describe('isIntentStatementId', () => {
  it('is true for a minted ID', () => {
    expect(isIntentStatementId(formatIntentStatementId('problem', 1))).toBe(true);
  });

  it('is false for a malformed string, a number, null, and undefined', () => {
    expect(isIntentStatementId('x')).toBe(false);
    expect(isIntentStatementId(42)).toBe(false);
    expect(isIntentStatementId(null)).toBe(false);
    expect(isIntentStatementId(undefined)).toBe(false);
  });
});

describe('TracesToSchema', () => {
  it('parses an empty array', () => {
    expect(TracesToSchema.parse([])).toEqual([]);
  });

  it('rejects an array with one malformed member', () => {
    expect(() => TracesToSchema.parse(['INT-SCOPE-01', 'nope'])).toThrow();
  });
});
