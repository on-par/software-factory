// src/checkers/check-outcome.ts — the CHECK success line

import type { CheckSummary } from '../types/index.js';

/** The CHECK success line (#3566): never "All checkers passed" when neither compile nor tests ran. */
export function describeCheckOutcome(summary: CheckSummary): string {
  const skippedNames = summary.results.filter((r) => r.result === 'SKIP').map((r) => r.checker);
  if (skippedNames.includes('compile') && skippedNames.includes('tests')) {
    const ran = summary.total - summary.skips;
    return `Nothing was built or tested — ${ran} of ${summary.total} checkers ran, ${summary.skips} skipped (${skippedNames.join(', ')})`;
  }
  return summary.skips > 0 ? `All checkers passed (${summary.skips} skipped)` : 'All checkers passed';
}
