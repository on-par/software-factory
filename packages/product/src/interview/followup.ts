// packages/product/src/interview/followup.ts — value-discovery laddering off an answer (#632).

import type { IntentDimension } from './dimensions.js';

/** Extra context handed to phraseQuestion when it is asked for a follow-up, not a fixed probe. */
export interface FollowUpContext {
  dimension: IntentDimension;
  /** The answer this follow-up ladders off — the most recent answer for this dimension. */
  answer: string;
  /** 1-based rung: 1 is the first follow-up after the fixed question. */
  depth: number;
  /** Every question already put for this dimension, fixed question first, in ask order. */
  asked: readonly string[];
  /** The value-discovery angle this rung should probe. Guidance for the model, not a question. */
  angle: string;
}

/** The laddering angles, in rung order. Guidance passed to the seam — never asked verbatim. */
export const FOLLOW_UP_ANGLES: readonly string[] = [
  'why does that matter — what value does it unlock, and for whom?',
  'what happens today without this — what does the status quo cost?',
];

/** Rungs per dimension: one pass over the angles. */
export const MAX_FOLLOW_UP_DEPTH = FOLLOW_UP_ANGLES.length;

/** Follow-ups allowed across one interview, separate from the dimension question budget. */
export const DEFAULT_FOLLOW_UP_BUDGET = 2;

/** The angle for a 1-based rung. Rungs past the list reuse the last angle. */
export function followUpAngle(depth: number): string {
  const index = Math.min(Math.max(Math.trunc(depth), 1), FOLLOW_UP_ANGLES.length) - 1;
  return FOLLOW_UP_ANGLES[index]!;
}

/** True when the seam returned a real, non-repeating follow-up. Blank or repeat = the seam declined. */
export function isUsableFollowUp(text: string | undefined, asked: readonly string[]): text is string {
  const trimmed = text?.trim() ?? '';
  if (trimmed === '') return false;
  const key = normalize(trimmed);
  return !asked.some((question) => normalize(question) === key);
}

function normalize(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[?.!]+$/, '');
}
