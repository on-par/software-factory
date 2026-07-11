import { describe, expect, it } from 'vitest';
import type { CaseResult, EvalSummary } from './types.js';
import { compareToBaseline, toBaseline } from './baseline.js';

function caseResult(overrides: Partial<CaseResult> = {}): CaseResult {
  return {
    id: 'case',
    pass: true,
    route: 'codex',
    routeCorrect: true,
    checks: [],
    judgeSkipped: true,
    model: 'stub-model',
    latencyMs: 10,
    costEstimate: 0,
    ...overrides,
  };
}

function summaryOf(results: CaseResult[]): EvalSummary {
  const total = results.length;
  const passed = results.filter(r => r.pass).length;
  return {
    results,
    total,
    passed,
    failed: total - passed,
    passRate: total ? passed / total : 0,
    totalCostEstimate: 0,
    totalLatencyMs: 0,
  };
}

describe('toBaseline', () => {
  it('maps an EvalSummary to the expected shape, omitting rubricScore when undefined', () => {
    const summary = summaryOf([
      caseResult({ id: 'a', pass: true }),
      caseResult({ id: 'b', pass: false, rubricScore: 8.5 }),
    ]);

    const baseline = toBaseline(summary);

    expect(baseline).toEqual({
      version: 1,
      tolerance: { passRate: 0, rubricScore: 1.0 },
      passRate: 0.5,
      cases: {
        a: { pass: true },
        b: { pass: false, rubricScore: 8.5 },
      },
    });
  });

  it('applies a custom tolerance when provided', () => {
    const summary = summaryOf([caseResult({ id: 'a' })]);
    const baseline = toBaseline(summary, { passRate: 0.1, rubricScore: 2 });
    expect(baseline.tolerance).toEqual({ passRate: 0.1, rubricScore: 2 });
  });
});

describe('compareToBaseline', () => {
  it('is ok when the summary matches the baseline exactly', () => {
    const summary = summaryOf([caseResult({ id: 'a', pass: true, rubricScore: 9 })]);
    const baseline = toBaseline(summary);

    const comparison = compareToBaseline(summary, baseline);

    expect(comparison).toEqual({ regressions: [], notes: [], ok: true });
  });

  it('flags an overall pass rate drop beyond tolerance', () => {
    const baseline = toBaseline(summaryOf([caseResult({ id: 'a' }), caseResult({ id: 'b' })]));
    const summary = summaryOf([caseResult({ id: 'a' }), caseResult({ id: 'b', pass: false })]);

    const comparison = compareToBaseline(summary, baseline);

    expect(comparison.ok).toBe(false);
    expect(comparison.regressions.some(r => r.includes('overall pass rate dropped'))).toBe(true);
  });

  it('flags a baseline-passing case that now fails', () => {
    const baseline = toBaseline(summaryOf([caseResult({ id: 'a', pass: true })]));
    const summary = summaryOf([caseResult({ id: 'a', pass: false })]);

    const comparison = compareToBaseline(summary, baseline);

    expect(comparison.ok).toBe(false);
    expect(comparison.regressions).toContain("case 'a' was passing in the baseline and now fails");
  });

  it('flags a rubric score below baseline minus tolerance', () => {
    const baseline = toBaseline(summaryOf([caseResult({ id: 'a', rubricScore: 8.0 })]));
    const summary = summaryOf([caseResult({ id: 'a', rubricScore: 6.5 })]);

    const comparison = compareToBaseline(summary, baseline);

    expect(comparison.ok).toBe(false);
    expect(comparison.regressions.some(r => r.includes("case 'a' rubric score dropped"))).toBe(true);
  });

  it('does not flag a within-tolerance rubric score drop', () => {
    const baseline = toBaseline(summaryOf([caseResult({ id: 'a', rubricScore: 8.0 })]));
    const summary = summaryOf([caseResult({ id: 'a', rubricScore: 7.5 })]);

    const comparison = compareToBaseline(summary, baseline);

    expect(comparison.ok).toBe(true);
    expect(comparison.regressions).toEqual([]);
  });

  it('notes a case present only in the run without failing', () => {
    const baseline = toBaseline(summaryOf([caseResult({ id: 'a' })]));
    const summary = summaryOf([caseResult({ id: 'a' }), caseResult({ id: 'b' })]);

    const comparison = compareToBaseline(summary, baseline);

    expect(comparison.ok).toBe(true);
    expect(comparison.notes).toContain("case 'b' is present in the run but missing from the baseline");
  });

  it('notes a case present only in the baseline without failing', () => {
    const baseline = toBaseline(summaryOf([caseResult({ id: 'a' }), caseResult({ id: 'b' })]));
    const summary = summaryOf([caseResult({ id: 'a' })]);

    const comparison = compareToBaseline(summary, baseline);

    expect(comparison.ok).toBe(true);
    expect(comparison.notes).toContain("case 'b' is present in the baseline but missing from the run");
  });
});
