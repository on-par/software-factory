import { describe, expect, it } from 'vitest';
import { compareToBaseline, toBaseline } from './baseline.js';
import { formatRegressionIssue, REGRESSION_ISSUE_MARKER, REGRESSION_ISSUE_TITLE } from './regression-report.js';
import { isRouteAsserted, type CaseResult, type EvalSummary } from './types.js';

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

function summaryOf(results: CaseResult[]): EvalSummary {
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
  };
}

describe('formatRegressionIssue', () => {
  it('formats a pass regression row with marker, run URL, and regression text', () => {
    const baseline = toBaseline(summaryOf([caseResult({ id: 'a', pass: true })]));
    const summary = summaryOf([caseResult({ id: 'a', pass: false })]);
    const comparison = compareToBaseline(summary, baseline);

    const issue = formatRegressionIssue(summary, baseline, comparison, 'https://example.test/run');

    expect(issue.body.split('\n')[0]).toBe(REGRESSION_ISSUE_MARKER);
    expect(issue.body).toContain('See the [workflow run](<https://example.test/run>).');
    expect(issue.body).toContain('| a | ✅ | ❌ | — | — | — | ⚠️ |');
    expect(issue.body).toContain("- case 'a' was passing in the baseline and now fails");
  });

  it('marks a rubric-drop regression with a negative delta', () => {
    const baseline = toBaseline(summaryOf([caseResult({ id: 'a', rubricScore: 8.0 })]), {
      passRate: 0,
      rubricScore: 1.0,
      routeAccuracy: 0,
    });
    const summary = summaryOf([caseResult({ id: 'a', rubricScore: 6.0 })]);
    const comparison = compareToBaseline(summary, baseline);

    const issue = formatRegressionIssue(summary, baseline, comparison, 'https://example.test/run');

    expect(issue.body).toContain('| a | ✅ | ✅ | 8.0 | 6.0 | -2.0 | ⚠️ |');
  });

  it('leaves a non-regressed case unmarked with a positive zero delta', () => {
    const baseline = toBaseline(summaryOf([caseResult({ id: 'a', rubricScore: 8.0 })]));
    const summary = summaryOf([caseResult({ id: 'a', rubricScore: 8.0 })]);
    const comparison = compareToBaseline(summary, baseline);

    const issue = formatRegressionIssue(summary, baseline, comparison, 'https://example.test/run');

    expect(issue.body).toContain('| a | ✅ | ✅ | 8.0 | 8.0 | +0.0 |  |');
  });

  it('renders missing baseline entries with dashes and no regression marker', () => {
    const baseline = toBaseline(summaryOf([caseResult({ id: 'a', rubricScore: 8.0 })]));
    const summary = summaryOf([caseResult({ id: 'a', rubricScore: 8.0 }), caseResult({ id: 'b', rubricScore: 7.0 })]);
    const comparison = compareToBaseline(summary, baseline);

    const issue = formatRegressionIssue(summary, baseline, comparison, 'https://example.test/run');

    expect(issue.body).toContain('| b | — | ✅ | — | 7.0 | — |  |');
  });

  it('escapes pipe characters in case ids so the markdown table stays intact', () => {
    const baseline = toBaseline(summaryOf([caseResult({ id: 'a|b', pass: true })]));
    const summary = summaryOf([caseResult({ id: 'a|b', pass: true })]);
    const comparison = compareToBaseline(summary, baseline);

    const issue = formatRegressionIssue(summary, baseline, comparison, 'https://example.test/run');

    expect(issue.body).toContain('| a\\|b | ✅ | ✅ | — | — | — |  |');
  });

  it('renders notes only when present', () => {
    const baselineWithMissingCase = toBaseline(summaryOf([caseResult({ id: 'a' })]));
    const summaryWithExtraCase = summaryOf([caseResult({ id: 'a' }), caseResult({ id: 'b' })]);
    const comparisonWithNotes = compareToBaseline(summaryWithExtraCase, baselineWithMissingCase);

    const issueWithNotes = formatRegressionIssue(
      summaryWithExtraCase,
      baselineWithMissingCase,
      comparisonWithNotes,
      'https://example.test/run',
    );

    expect(issueWithNotes.body).toContain('## Notes');
    expect(issueWithNotes.body).toContain("- case 'b' is present in the run but missing from the baseline");

    const baselineWithoutNotes = toBaseline(summaryOf([caseResult({ id: 'a', pass: true })]));
    const summaryWithoutNotes = summaryOf([caseResult({ id: 'a', pass: false })]);
    const comparisonWithoutNotes = compareToBaseline(summaryWithoutNotes, baselineWithoutNotes);

    const issueWithoutNotes = formatRegressionIssue(
      summaryWithoutNotes,
      baselineWithoutNotes,
      comparisonWithoutNotes,
      'https://example.test/run',
    );

    expect(issueWithoutNotes.body).not.toContain('## Notes');
  });

  it('returns the stable title constant', () => {
    const baseline = toBaseline(summaryOf([caseResult({ id: 'a', pass: true })]));
    const summary = summaryOf([caseResult({ id: 'a', pass: false })]);
    const comparison = compareToBaseline(summary, baseline);

    const issue = formatRegressionIssue(summary, baseline, comparison, 'https://example.test/run');

    expect(issue.title).toBe(REGRESSION_ISSUE_TITLE);
  });
});
