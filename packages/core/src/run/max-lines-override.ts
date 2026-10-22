import type { CheckSummary } from '../types/index.js';

/** PR label a human applies to approve a raised max-lines baseline ceiling (#3466). */
export const MAX_LINES_OVERRIDE_LABEL = 'max-lines:override';

/** Labels only a human may apply; the factory filters them out of every label write it makes (#3466). */
export const HUMAN_ONLY_LABELS: readonly string[] = [MAX_LINES_OVERRIDE_LABEL];

/** Drops every human-only label (case-insensitive, trimmed) from a label list. */
export function withoutHumanOnlyLabels(labels: readonly string[]): string[] {
  return labels.filter((label) => !HUMAN_ONLY_LABELS.includes(label.trim().toLowerCase()));
}

export const MAX_LINES_OVERRIDE_RULE = `If a change would push a file past its max-lines ceiling (including a max-lines-baseline.json entry), split the file by responsibility. Never raise or add a baseline entry, never apply the \`${MAX_LINES_OVERRIDE_LABEL}\` label, and never compact unrelated code to fit. If the file cannot sensibly shrink, say in the PR body that a human must apply \`${MAX_LINES_OVERRIDE_LABEL}\`.`;

/** Park-message hint when a CHECK failure is a max-lines failure; undefined otherwise. */
export function maxLinesOverrideHint(summary: CheckSummary): string | undefined {
  const hit = summary.results.some((r) => r.result === 'FAIL' && /max-lines|too many lines/i.test(r.details));
  return hit
    ? `a file is over its max-lines ceiling: split the file, or ask a human to apply the ${MAX_LINES_OVERRIDE_LABEL} label (the factory never applies it)`
    : undefined;
}
