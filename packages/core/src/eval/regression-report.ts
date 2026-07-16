import type { Baseline, BaselineComparison } from './baseline.js';
import type { EvalSummary } from './types.js';

export const REGRESSION_ISSUE_TITLE = 'Weekly prompt eval regression';
export const REGRESSION_ISSUE_MARKER = '<!-- weekly-prompt-eval-regression -->';

export interface RegressionIssue {
  title: string;
  body: string;
}

export function formatRegressionIssue(
  summary: EvalSummary,
  baseline: Baseline,
  comparison: BaselineComparison,
  runUrl: string,
): RegressionIssue {
  const lines = [
    REGRESSION_ISSUE_MARKER,
    `Weekly prompt eval regression detected. See the [workflow run](<${runUrl}>).`,
    '',
    `**Overall pass rate:** ${summary.passRate} (baseline ${baseline.passRate}, tolerance ${baseline.tolerance.passRate})`,
    '',
    '## Per-case deltas',
    '| case | baseline pass | current pass | baseline rubric | current rubric | Δ rubric | |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...summary.results.map(result => {
      const baselineCase = baseline.cases[result.id];
      const regressed =
        (baselineCase?.pass === true && !result.pass) ||
        (baselineCase?.rubricScore !== undefined &&
          result.rubricScore !== undefined &&
          result.rubricScore < baselineCase.rubricScore - baseline.tolerance.rubricScore);

      const columns = [
        escapeCell(result.id),
        formatPass(baselineCase?.pass),
        formatPass(result.pass),
        formatScore(baselineCase?.rubricScore),
        formatScore(result.rubricScore),
        formatDelta(result.rubricScore, baselineCase?.rubricScore),
        regressed ? '⚠️' : '',
      ];

      return `| ${columns.join(' | ')} |`;
    }),
    '',
    '## Regressions',
    ...comparison.regressions.map(regression => `- ${regression}`),
  ];

  if (comparison.notes.length > 0) {
    lines.push('', '## Notes', ...comparison.notes.map(note => `- ${note}`));
  }

  return {
    title: REGRESSION_ISSUE_TITLE,
    body: lines.join('\n'),
  };
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|');
}

function formatPass(pass: boolean | undefined): string {
  if (pass === undefined) return '—';
  return pass ? '✅' : '❌';
}

function formatScore(score: number | undefined): string {
  return score === undefined ? '—' : score.toFixed(1);
}

function formatDelta(current: number | undefined, baseline: number | undefined): string {
  if (current === undefined || baseline === undefined) return '—';
  const delta = current - baseline;
  return `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}`;
}
