// src/models/zdr-review.ts — Doctor downgrade for intermediaries past their ZDR review date (ADR-0163, #2897)

import { intermediaryFor } from '../config/intermediaries.js';
import type { ModelDiagnosis } from './index.js';

/** Doctor reason when `providerModel`'s intermediary is past its ZDR review date (ADR-0163); null otherwise. */
export function zdrReviewReason(providerModel: string, now: Date): string | null {
  const intermediary = intermediaryFor(providerModel);
  if (!intermediary?.reviewBy) return null;
  if (now.toISOString().slice(0, 10) <= intermediary.reviewBy) return null; // the review day itself is still valid
  return `ZDR review date ${intermediary.reviewBy} passed for ${intermediary.name}; re-check the agreement (ADR-0163)`;
}

/** Rows diagnoseModels excluded without probing (experimental-disabled / FACTORY_LOCAL_ONLY). */
function isExcludedRow(d: ModelDiagnosis): boolean {
  return d.reason.startsWith('experimental —') || d.reason === 'excluded by FACTORY_LOCAL_ONLY=1';
}

/** Downgrade a doctor row whose intermediary's ZDR review date has passed (#2897). */
export function applyZdrReview(
  d: ModelDiagnosis,
  providerModel: string,
  now: () => Date = () => new Date(),
): ModelDiagnosis {
  const zdr = zdrReviewReason(providerModel, now());
  if (!zdr) return d;
  if (d.reachable || d.unverified) return { ...d, reachable: false, unverified: true, reason: `${zdr} (${d.reason})` };
  if (isExcludedRow(d)) return d;
  return { ...d, reason: `${d.reason}; ${zdr}` };
}
