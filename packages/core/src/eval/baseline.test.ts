import { describe, expect, it } from 'vitest';

import { compareToBaseline, toBaseline } from './baseline.js';
import { type CaseResult, type EvalSummary, isRouteAsserted } from './types.js';

function caseResult(overrides: Partial<CaseResult> = {}): CaseResult {
  return {
    id: 'case',
    pass: true,
    route: 'codex',
    expectedRoute: 'codex',
    routeCorrect: true,
    checks: [],
    judgeSkipped: true,
    model: 'stub-model',
    latencyMs: 10,
    costEstimate: 0,
    ...overrides,
  };
}

function summaryOf(results: CaseResult[], overrides: Partial<EvalSummary> = {}): EvalSummary {
  const total = results.length;
  const passed = results.filter((r) => r.pass).length;
  const routeAsserted = results.filter((r) => isRouteAsserted(r.expectedRoute)).length;
  const routeCorrect = results.filter((r) => isRouteAsserted(r.expectedRoute) && r.routeCorrect).length;
  return {
    results,
    total,
    passed,
    failed: total - passed,
    passRate: total ? passed / total : 0,
    routeAsserted,
    routeAccuracy: routeAsserted ? routeCorrect / routeAsserted : 1,
    totalCostEstimate: 0,
    totalLatencyMs: 0,
    ...overrides,
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
      tolerance: { passRate: 0, rubricScore: 1.0, routeAccuracy: 0 },
      passRate: 0.5,
      routeAccuracy: 1,
      cases: {
        a: { pass: true },
        b: { pass: false, rubricScore: 8.5 },
      },
    });
  });

  it('applies a custom tolerance when provided', () => {
    const summary = summaryOf([caseResult({ id: 'a' })]);
    const baseline = toBaseline(summary, { passRate: 0.1, rubricScore: 2, routeAccuracy: 0.2 });
    expect(baseline.tolerance).toEqual({ passRate: 0.1, rubricScore: 2, routeAccuracy: 0.2 });
  });

  it('includes budgets only when provided', () => {
    const summary = summaryOf([caseResult({ id: 'a' })]);
    const budgets = { totalCostEstimate: 1, latencyMs: 120000 };

    const baselineWithBudgets = toBaseline(summary, { passRate: 0.1, rubricScore: 2, routeAccuracy: 0.2 }, budgets);
    const baselineWithoutBudgets = toBaseline(summary);

    expect(baselineWithBudgets.budgets).toEqual(budgets);
    expect(baselineWithoutBudgets.budgets).toBeUndefined();
  });

  it('carries routing accuracy through the baseline', () => {
    const summary = summaryOf([
      caseResult({ id: 'a' }),
      caseResult({ id: 'x', expectedRoute: 'claude', route: 'codex', routeCorrect: false }),
    ]);

    const baseline = toBaseline(summary);

    expect(summary.routeAccuracy).toBe(0.5);
    expect(baseline.routeAccuracy).toBe(0.5);
  });

  it('excludes any route cases from routing accuracy', () => {
    const withAny = summaryOf([caseResult({ id: 'any', expectedRoute: 'any' }), caseResult({ id: 'asserted' })]);
    const onlyAny = summaryOf([caseResult({ id: 'any', expectedRoute: 'any' })]);

    expect(withAny.routeAsserted).toBe(1);
    expect(withAny.routeAccuracy).toBe(1);
    expect(onlyAny.routeAsserted).toBe(0);
    expect(onlyAny.routeAccuracy).toBe(1);
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
    expect(comparison.regressions.some((r) => r.includes('overall pass rate dropped'))).toBe(true);
  });

  it('flags a routing accuracy regression and names misrouted cases', () => {
    const baseline = toBaseline(summaryOf([caseResult({ id: 'a' }), caseResult({ id: 'b' })]));
    const summary = summaryOf([
      caseResult({ id: 'a' }),
      caseResult({ id: 'misroute', expectedRoute: 'claude', route: 'codex', routeCorrect: false }),
    ]);

    const comparison = compareToBaseline(summary, baseline);

    expect(comparison.ok).toBe(false);
    expect(
      comparison.regressions.some((r) => /routing accuracy dropped/.test(r) && r.includes('misrouted: misroute')),
    ).toBe(true);
  });

  it('does not flag a within-tolerance routing accuracy drop', () => {
    const baseline = toBaseline(summaryOf([caseResult({ id: 'a' }), caseResult({ id: 'b' })]), {
      passRate: 0,
      rubricScore: 1.0,
      routeAccuracy: 0.5,
    });
    const summary = summaryOf([
      caseResult({ id: 'a' }),
      caseResult({ id: 'b', expectedRoute: 'claude', route: 'codex', routeCorrect: false }),
    ]);

    const comparison = compareToBaseline(summary, baseline);

    expect(comparison.ok).toBe(true);
    expect(comparison.regressions).toEqual([]);
  });

  it('flags a cost budget breach', () => {
    const summary = summaryOf([caseResult({ id: 'a' })], { totalCostEstimate: 0.75 });
    const baseline = toBaseline(
      summaryOf([caseResult({ id: 'a' })]),
      { passRate: 0, rubricScore: 1.0, routeAccuracy: 0 },
      { totalCostEstimate: 0.5 },
    );

    const comparison = compareToBaseline(summary, baseline);

    expect(comparison.ok).toBe(false);
    expect(comparison.regressions.some((r) => r.includes('estimated cost exceeds budget'))).toBe(true);
  });

  it('flags a latency budget breach and names the case', () => {
    const summary = summaryOf([caseResult({ id: 'slow-case', latencyMs: 250 })]);
    const baseline = toBaseline(
      summaryOf([caseResult({ id: 'slow-case' })]),
      { passRate: 0, rubricScore: 1.0, routeAccuracy: 0 },
      { latencyMs: 100 },
    );

    const comparison = compareToBaseline(summary, baseline);

    expect(comparison.ok).toBe(false);
    expect(comparison.regressions).toContain("case 'slow-case' latency exceeds budget: 250ms > budget 100ms");
  });

  it('does not flag budget regressions when within budget or budgets are absent', () => {
    const summary = summaryOf([caseResult({ id: 'a', latencyMs: 80 }), caseResult({ id: 'b', latencyMs: 90 })], {
      totalCostEstimate: 0.25,
    });
    const baselineWithBudgets = toBaseline(
      summaryOf([caseResult({ id: 'a' }), caseResult({ id: 'b' })]),
      { passRate: 0, rubricScore: 1.0, routeAccuracy: 0 },
      { totalCostEstimate: 0.5, latencyMs: 100 },
    );
    const baselineWithoutBudgets = toBaseline(summaryOf([caseResult({ id: 'a' }), caseResult({ id: 'b' })]));

    const withinBudget = compareToBaseline(summary, baselineWithBudgets);
    const withoutBudgets = compareToBaseline(
      summaryOf([caseResult({ id: 'a', latencyMs: 250 })], { totalCostEstimate: 0.75 }),
      baselineWithoutBudgets,
    );

    expect(withinBudget.ok).toBe(true);
    expect(withinBudget.regressions.filter((r) => r.includes('budget'))).toEqual([]);
    expect(withoutBudgets.ok).toBe(true);
    expect(withoutBudgets.regressions.filter((r) => r.includes('budget'))).toEqual([]);
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
    expect(comparison.regressions.some((r) => r.includes("case 'a' rubric score dropped"))).toBe(true);
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
