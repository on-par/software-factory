// src/phases/plan-escalation.ts — planner ESCALATE line classification, split out of plan.ts

import type { EscalateKind } from '../types/index.js';

/** Classify a planner ESCALATE line for the escalate event (#3275). */
export function classifyEscalation(line: string | undefined): EscalateKind | undefined {
  if (!line) return undefined;
  const rest = line.replace(/^\s*ESCALATE:\s*/i, '');
  if (/^missing-info:/i.test(rest)) return 'missing-info';
  if (/^contradiction:/i.test(rest)) return 'contradiction';
  if (/\b(split|slices?|smaller|too (big|large)|size)\b/i.test(rest)) return 'split';
  return undefined;
}
