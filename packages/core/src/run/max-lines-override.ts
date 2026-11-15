import type { CheckSummary } from '../types/index.js';

export const MAX_LINES_OVERRIDE_LABEL = 'max-lines:override';

const LOC_BUDGET_OVERRIDE_LABEL = 'loc-budget:override';

export const HUMAN_ONLY_LABELS: readonly string[] = [MAX_LINES_OVERRIDE_LABEL, LOC_BUDGET_OVERRIDE_LABEL];

export function withoutHumanOnlyLabels(labels: readonly string[]): string[] {
  return labels.filter((label) => !HUMAN_ONLY_LABELS.includes(label.trim().toLowerCase()));
}

export const MAX_LINES_OVERRIDE_RULE = `If a change would push a file past its max-lines ceiling (including a max-lines-baseline.json entry), split the file by responsibility. Never raise or add a baseline entry, never apply the \`${MAX_LINES_OVERRIDE_LABEL}\` label, and never compact unrelated code to fit. If the file cannot sensibly shrink, say in the PR body that a human must apply \`${MAX_LINES_OVERRIDE_LABEL}\`.`;

export function maxLinesOverrideHint(summary: CheckSummary): string | undefined {
  const hit = summary.results.some((r) => r.result === 'FAIL' && /max-lines|too many lines/i.test(r.details));
  return hit
    ? `a file is over its max-lines ceiling: split the file, or ask a human to apply the ${MAX_LINES_OVERRIDE_LABEL} label (the factory never applies it)`
    : undefined;
}
