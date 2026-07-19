import { type EvalSummary, isRouteAsserted } from './types.js';

export interface BaselineCase {
  pass: boolean;
  rubricScore?: number;
}

export interface Baseline {
  version: 1;
  tolerance: { passRate: number; rubricScore: number; routeAccuracy: number };
  budgets?: { totalCostEstimate?: number; latencyMs?: number };
  passRate: number;
  routeAccuracy: number;
  cases: Record<string, BaselineCase>;
}

export interface BaselineComparison {
  regressions: string[];
  notes: string[];
  ok: boolean;
  infraFailure?: { erroredCases: string[]; firstError: string };
}

const DEFAULT_TOLERANCE: Baseline['tolerance'] = { passRate: 0, rubricScore: 1.0, routeAccuracy: 0 };

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

export function toBaseline(
  summary: EvalSummary,
  tolerance: Baseline['tolerance'] = DEFAULT_TOLERANCE,
  budgets?: Baseline['budgets'],
): Baseline {
  const cases: Record<string, BaselineCase> = {};
  for (const result of summary.results) {
    cases[result.id] = {
      pass: result.pass,
      ...(result.rubricScore !== undefined ? { rubricScore: result.rubricScore } : {}),
    };
  }
  return {
    version: 1,
    tolerance,
    ...(budgets ? { budgets } : {}),
    passRate: summary.passRate,
    routeAccuracy: summary.routeAccuracy,
    cases,
  };
}

export function compareToBaseline(summary: EvalSummary, baseline: Baseline): BaselineComparison {
  const regressions: string[] = [];
  const notes: string[] = [];

  const errored = summary.results.filter((r) => r.error !== undefined && r.checks.length === 0);
  if (errored.length === summary.results.length && summary.results.length > 0) {
    const runIds = new Set(summary.results.map((result) => result.id));
    const baselineIds = new Set(Object.keys(baseline.cases));

    for (const result of summary.results) {
      if (!baseline.cases[result.id]) {
        notes.push(`case '${result.id}' is present in the run but missing from the baseline`);
      }
    }
    for (const id of baselineIds) {
      if (!runIds.has(id)) {
        notes.push(`case '${id}' is present in the baseline but missing from the run`);
      }
    }
    notes.push('per-case and routing regressions suppressed: every case failed at execution, not at spec quality');

    const firstError = truncate(collapse(errored[0].error ?? ''), 300);
    return {
      regressions: [
        `eval infrastructure failure: all ${summary.results.length} cases errored before producing a spec — first error: ${firstError}`,
      ],
      notes,
      ok: false,
      infraFailure: { erroredCases: errored.map((r) => r.id), firstError },
    };
  }

  if (summary.passRate < baseline.passRate - baseline.tolerance.passRate) {
    regressions.push(
      `overall pass rate dropped: ${summary.passRate} < baseline ${baseline.passRate} - tolerance ${baseline.tolerance.passRate}`,
    );
  }

  if (
    baseline.routeAccuracy !== undefined &&
    summary.routeAccuracy < baseline.routeAccuracy - (baseline.tolerance.routeAccuracy ?? 0)
  ) {
    const misrouted = summary.results
      .filter((result) => isRouteAsserted(result.expectedRoute) && !result.routeCorrect)
      .map((result) => result.id);
    regressions.push(
      `routing accuracy dropped: ${summary.routeAccuracy} < baseline ${baseline.routeAccuracy} ` +
        `- tolerance ${baseline.tolerance.routeAccuracy ?? 0}` +
        (misrouted.length ? ` (misrouted: ${misrouted.join(', ')})` : ''),
    );
  }

  if (
    baseline.budgets?.totalCostEstimate !== undefined &&
    summary.totalCostEstimate > baseline.budgets.totalCostEstimate
  ) {
    regressions.push(
      `estimated cost exceeds budget: ${summary.totalCostEstimate} > budget ${baseline.budgets.totalCostEstimate}`,
    );
  }

  if (baseline.budgets?.latencyMs !== undefined) {
    for (const result of summary.results) {
      if (result.latencyMs > baseline.budgets.latencyMs) {
        regressions.push(
          `case '${result.id}' latency exceeds budget: ${result.latencyMs}ms > budget ${baseline.budgets.latencyMs}ms`,
        );
      }
    }
  }

  const runIds = new Set(summary.results.map((result) => result.id));
  const baselineIds = new Set(Object.keys(baseline.cases));

  for (const result of summary.results) {
    const baselineCase = baseline.cases[result.id];
    if (!baselineCase) {
      notes.push(`case '${result.id}' is present in the run but missing from the baseline`);
      continue;
    }

    if (baselineCase.pass && !result.pass) {
      regressions.push(`case '${result.id}' was passing in the baseline and now fails`);
    }

    if (baselineCase.rubricScore !== undefined && result.rubricScore !== undefined) {
      if (result.rubricScore < baselineCase.rubricScore - baseline.tolerance.rubricScore) {
        regressions.push(
          `case '${result.id}' rubric score dropped: ${result.rubricScore} < baseline ${baselineCase.rubricScore} - tolerance ${baseline.tolerance.rubricScore}`,
        );
      }
    }
  }

  for (const id of baselineIds) {
    if (!runIds.has(id)) {
      notes.push(`case '${id}' is present in the baseline but missing from the run`);
    }
  }

  return {
    regressions,
    notes,
    ok: regressions.length === 0,
  };
}
