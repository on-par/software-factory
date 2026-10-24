// src/phases/check-showstoppers.ts — lens_review showstopper parsing, split out of check.ts

import type { CheckSummary } from '../types/index.js';

/** Checker name of the model-judged showstopper review (#2236); signed by file:line, not prose (#2238). */
export const LENS_REVIEW_CHECKER = 'lens_review';

/** Matches one lens_review showstopper line: optional bullet, `file:line`, then a dash separator (#2238). */
const SHOWSTOPPER_LINE = /^\s*(?:[-*•]\s+)?(\S.*?:\d+)\s+[—–-]\s+\S/;

/** Sorted, de-duplicated `file:line` refs of the showstoppers in lens_review FAIL details. */
export function lensShowstopperRefs(details: string): string[] {
  const refs = new Set<string>();
  for (const line of details.split('\n')) {
    const m = SHOWSTOPPER_LINE.exec(line);
    if (m) refs.add(m[1].trim());
  }
  return [...refs].sort();
}

/** The showstopper lines of a lens_review FAIL in `summary`, for park messages (#2238); empty when none. */
export function remainingShowstoppers(summary: CheckSummary): string[] {
  const lens = summary.results.find((r) => r.checker === LENS_REVIEW_CHECKER && r.result === 'FAIL');
  if (!lens) return [];
  return lens.details
    .split('\n')
    .filter((line) => SHOWSTOPPER_LINE.test(line))
    .map((line) => line.trim());
}
