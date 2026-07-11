import type { EvalSummary } from './types.js';

export interface BaselineCase {
  pass: boolean;
  rubricScore?: number;
}

export interface Baseline {
  version: 1;
  tolerance: { passRate: number; rubricScore: number };
  passRate: number;
  cases: Record<string, BaselineCase>;
}

export interface BaselineComparison {
  regressions: string[];
  notes: string[];
  ok: boolean;
}

const DEFAULT_TOLERANCE: Baseline['tolerance'] = { passRate: 0, rubricScore: 1.0 };

export function toBaseline(summary: EvalSummary, tolerance: Baseline['tolerance'] = DEFAULT_TOLERANCE): Baseline {
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
    passRate: summary.passRate,
    cases,
  };
}

export function compareToBaseline(summary: EvalSummary, baseline: Baseline): BaselineComparison {
  const regressions: string[] = [];
  const notes: string[] = [];

  if (summary.passRate < baseline.passRate - baseline.tolerance.passRate) {
    regressions.push(
      `overall pass rate dropped: ${summary.passRate} < baseline ${baseline.passRate} - tolerance ${baseline.tolerance.passRate}`,
    );
  }

  const runIds = new Set(summary.results.map(result => result.id));
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
