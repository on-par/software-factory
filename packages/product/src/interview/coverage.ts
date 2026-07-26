// packages/product/src/interview/coverage.ts — cue matching against a brain-dump (#470).

import type { IntentDimension } from './dimensions.js';
import { DIMENSION_PROBES } from './dimensions.js';

/** Dimensions the text already says something about, in canonical ask order. */
export function detectCoverage(text: string): readonly IntentDimension[] {
  const haystack = text.toLowerCase();
  return DIMENSION_PROBES.filter((probe) => probe.cues.some((cue) => haystack.includes(cue))).map((p) => p.dimension);
}

/** Answers that decline the question — they must not pin a dimension. */
const DECLINED = /^(i\s+)?(don'?t\s+know|dunno|no\s+idea|not\s+sure|unsure|unknown|n\/?a|tbd|skip|pass)\b/i;

/** True when an answer is substantive enough to pin its dimension. */
export function isSubstantiveAnswer(answer: string): boolean {
  const trimmed = answer.trim();
  return trimmed.length >= 3 && !DECLINED.test(trimmed);
}
