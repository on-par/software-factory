import type { CheckSummary } from '../types/index.js';

export function describeCheckOutcome(summary: CheckSummary): string {
  const skippedNames = summary.results.filter((r) => r.result === 'SKIP').map((r) => r.checker);
  const nothingWasBuiltOrTested = skippedNames.includes('compile') && skippedNames.includes('tests');
  if (nothingWasBuiltOrTested) {
    const ran = summary.total - summary.skips;
    return `Nothing was built or tested — ${ran} of ${summary.total} checkers ran, ${summary.skips} skipped (${skippedNames.join(', ')})`;
  }
  return summary.skips > 0 ? `All checkers passed (${summary.skips} skipped)` : 'All checkers passed';
}
