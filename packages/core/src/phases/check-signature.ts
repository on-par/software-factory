// src/phases/check-signature.ts — failing-check signatures for stuck detection, split out of check.ts

import type { CheckerOutput, CheckSummary } from '../types/index.js';
import { LENS_REVIEW_CHECKER, lensShowstopperRefs } from './check-showstoppers.js';

/** Deterministic signature of the failing checks: name + volatility-stripped detail. */
export function failureSignature(summary: CheckSummary): string {
  return summary.results
    .filter((r) => r.result === 'FAIL')
    .map((r) => `${r.checker}:${signatureDetail(r)}`)
    .sort()
    .join('|');
}

/** lens_review is signed by its showstopper refs (LLM prose drifts each round, #2238); everything else by normalized detail. */
function signatureDetail(r: CheckerOutput): string {
  if (r.checker === LENS_REVIEW_CHECKER) {
    const refs = lensShowstopperRefs(r.details);
    if (refs.length > 0) return refs.join(',');
  }
  return normalizeDetail(r.details);
}

function normalizeDetail(details: string): string {
  return details.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 200);
}
