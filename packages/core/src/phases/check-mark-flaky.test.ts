// src/phases/check-mark-flaky.test.ts — markTestsFlaky, split out of check.test.ts

import { describe, expect, it } from 'vitest';

import type { CheckSummary } from '../types/index.js';
import { markTestsFlaky } from './check.js';

describe('markTestsFlaky (#2302)', () => {
  const base: CheckSummary = {
    results: [
      { checker: 'tests', result: 'FAIL', details: 'x' },
      { checker: 'lint', result: 'FAIL', details: 'y' },
      { checker: 'types', result: 'PASS', details: 'z' },
    ],
    failures: 2,
    passes: 1,
    skips: 3,
    total: 6,
  };

  it('joins targeted names, recomputes counts and preserves other fields', () => {
    const out = markTestsFlaky(base, { verdict: 'passed', mode: 'targeted', tests: ['a', 'b'] });
    expect(out.results[0]).toEqual({ checker: 'tests', result: 'PASS', details: 're-run passed; flaky: a, b' });
    expect(out.results[1]).toBe(base.results[1]);
    expect(out.failures).toBe(1);
    expect(out.passes).toBe(2);
    expect(out.skips).toBe(3);
    expect(out.total).toBe(6);
  });
  it('falls back to full suite and leaves a non-FAIL tests result alone', () => {
    const out = markTestsFlaky(base, { verdict: 'passed', mode: 'full', tests: [] });
    expect(out.results[0]?.details).toBe('re-run passed; flaky: full suite');
    const passing: CheckSummary = { ...base, results: [{ checker: 'tests', result: 'PASS', details: 'ok' }] };
    expect(markTestsFlaky(passing, { verdict: 'passed', mode: 'full', tests: [] }).results[0]?.details).toBe('ok');
  });
});
