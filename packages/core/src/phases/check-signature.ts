import type { CheckerOutput, CheckSummary } from '../types/index.js';
import { LENS_REVIEW_CHECKER, lensShowstopperRefs } from './check-showstoppers.js';

export function failureSignature(summary: CheckSummary): string {
  return summary.results
    .filter((r) => r.result === 'FAIL')
    .map((r) => `${r.checker}:${signatureDetail(r)}`)
    .sort()
    .join('|');
}

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
