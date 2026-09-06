import { describe, expect, it } from 'vitest';

import { findLeakedValues } from './leak-guard.js';

describe('findLeakedValues', () => {
  it('returns [] when no hidden value appears in the rendered text', () => {
    const rendered = 'Nothing sensitive in here.';
    expect(findLeakedValues(rendered, { testNames: ['test_secret'], problemIds: ['secret-problem'] })).toEqual([]);
  });

  it('returns the leaked test name when one of hidden.testNames is a substring of rendered', () => {
    const rendered = 'Failing tests that must pass:\n\n- Core: test_secret_case';
    expect(findLeakedValues(rendered, { testNames: ['test_secret_case'], problemIds: [] })).toEqual([
      'test_secret_case',
    ]);
  });

  it('returns the leaked problem id when one of hidden.problemIds is a substring of rendered', () => {
    const rendered = '# SCBench secret-problem-id — checkpoint 1';
    expect(findLeakedValues(rendered, { testNames: [], problemIds: ['secret-problem-id'] })).toEqual([
      'secret-problem-id',
    ]);
  });

  it('returns all leaked values, in combined testNames-then-problemIds order, when more than one is present', () => {
    const rendered = 'test_a and test_b and problem-a and problem-b all appear here';
    const found = findLeakedValues(rendered, {
      testNames: ['test_a', 'test_b'],
      problemIds: ['problem-a', 'problem-b'],
    });
    expect(found).toEqual(['test_a', 'test_b', 'problem-a', 'problem-b']);
  });

  it('returns [] for empty testNames/problemIds arrays', () => {
    expect(findLeakedValues('anything at all', { testNames: [], problemIds: [] })).toEqual([]);
  });
});
