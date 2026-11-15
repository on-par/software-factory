import type { CheckSummary } from '../types/index.js';

export const LENS_REVIEW_CHECKER = 'lens_review';

const SHOWSTOPPER_LINE = /^\s*(?:[-*•]\s+)?(\S.*?:\d+)\s+[—–-]\s+\S/;

export function lensShowstopperRefs(details: string): string[] {
  const refs = new Set<string>();
  for (const line of details.split('\n')) {
    const m = SHOWSTOPPER_LINE.exec(line);
    if (m) refs.add(m[1].trim());
  }
  return [...refs].sort();
}

export function remainingShowstoppers(summary: CheckSummary): string[] {
  const lens = summary.results.find((r) => r.checker === LENS_REVIEW_CHECKER && r.result === 'FAIL');
  if (!lens) return [];
  return lens.details
    .split('\n')
    .filter((line) => SHOWSTOPPER_LINE.test(line))
    .map((line) => line.trim());
}
