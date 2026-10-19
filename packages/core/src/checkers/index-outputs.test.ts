import { describe, expect, it } from 'vitest';

import { listBuiltInCheckers, summarizeCheckerOutputs } from './index.js';

describe('summarizeCheckerOutputs', () => {
  it('tallies ordinary results and preserves the result array', () => {
    const results = [
      { checker: 'compile', result: 'PASS' as const, details: 'ok' },
      { checker: 'tests', result: 'FAIL' as const, details: 'bad' },
      { checker: 'lint', result: 'SKIP' as const, details: 'none' },
      { checker: 'links', result: 'SKIP' as const, details: 'none' },
    ];
    expect(summarizeCheckerOutputs(results)).toEqual({ failures: 1, passes: 1, skips: 2, total: 4, results });
    expect(summarizeCheckerOutputs([])).toEqual({ failures: 0, passes: 0, skips: 0, total: 0, results: [] });
  });

  it('counts and preserves structured evidence-plan outcomes without registry selection', () => {
    const evidencePlanResults = [
      { claim: 'AC-1', kind: 'command' as const, status: 'PASS' as const, reason: 'passed' },
    ];
    const output = { checker: 'evidence_plan', result: 'PASS' as const, details: 'AC-1 passed', evidencePlanResults };
    expect(summarizeCheckerOutputs([output])).toEqual({
      failures: 0,
      passes: 1,
      skips: 0,
      total: 1,
      results: [output],
    });
    expect(listBuiltInCheckers().map((checker) => checker.name)).not.toContain('evidence_plan');
  });
});
