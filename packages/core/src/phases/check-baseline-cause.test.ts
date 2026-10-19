import { describe, expect, it } from 'vitest';

import { schemaErrorCheckerOutput, unfilledPlaceholderCheckerOutput, unknownCheckerOutput } from '../checkers/index.js';
import type { CheckSummary } from '../types/index.js';
import { classifyBaseFailureCause } from './check.js';

describe('classifyBaseFailureCause (#2582)', () => {
  const summaryWith = (...results: CheckSummary['results']): CheckSummary => ({
    results,
    failures: results.length,
    passes: 0,
    skips: 0,
    total: results.length,
  });

  it('is config for a schema-error-only summary', () => {
    expect(classifyBaseFailureCause(summaryWith(schemaErrorCheckerOutput('checkers', 'is a string, not a list')))).toBe(
      'config',
    );
  });

  it('is config for a placeholder-only summary', () => {
    expect(classifyBaseFailureCause(summaryWith(unfilledPlaceholderCheckerOutput('<checker-name>')))).toBe('config');
  });

  it('is environment when no output is a config output', () => {
    expect(
      classifyBaseFailureCause(
        summaryWith({ checker: 'tests', result: 'FAIL', details: 'zod schema error: unfilled placeholder' }),
      ),
    ).toBe('environment');
  });
});

describe('classifyBaseFailureCause (#2581)', () => {
  const summaryWith = (...results: Array<{ checker: string; details: string }>): CheckSummary => ({
    results: results.map((r) => ({ ...r, result: 'FAIL' as const })),
    failures: results.length,
    passes: 0,
    skips: 0,
    total: results.length,
  });
  const unknown = unknownCheckerOutput('typecheck');

  it('is config for an unknown-checker-only summary', () => {
    expect(classifyBaseFailureCause(summaryWith(unknown))).toBe('config');
  });

  it('is config when an unknown checker fails alongside a real checker', () => {
    expect(classifyBaseFailureCause(summaryWith(unknown, { checker: 'lint', details: 'boom' }))).toBe('config');
  });

  it('is environment when no failure is an unknown-checker output', () => {
    expect(
      classifyBaseFailureCause(summaryWith({ checker: 'tests', details: 'x' }, { checker: 'lint', details: 'y' })),
    ).toBe('environment');
  });

  it('is environment when details only mention unknown checker mid-text', () => {
    expect(classifyBaseFailureCause(summaryWith({ checker: 'lint', details: 'saw an unknown checker here' }))).toBe(
      'environment',
    );
  });
});
