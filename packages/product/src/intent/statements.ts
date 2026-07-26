// packages/product/src/intent/statements.ts — deterministic statement extraction (#471).

import type { IntentDimension, InterviewResult } from '../interview/index.js';
import { INTENT_DIMENSIONS, probeFor } from '../interview/index.js';

export interface IntentStatementDraft {
  dimension: IntentDimension;
  text: string;
  /** Where the statement came from: a clarifying answer, or the original brain-dump. */
  source: 'answer' | 'brain-dump';
}

const LEADING_MARKER = /^\s*(?:[-*+]|\d+[.)])\s+/;
const SENTENCE_SPLIT = /(?<=[.!?])\s+/;

/** Split prose into statement-sized pieces: one per line, bullet, or sentence. */
export function splitStatements(text: string): string[] {
  return text
    .split(/\r?\n/)
    .flatMap((line) => line.split(SENTENCE_SPLIT))
    .map((piece) => piece.replace(LEADING_MARKER, '').trim())
    .filter((piece) => piece.length >= 3);
}

/** Statements for every dimension the interview pinned, in canonical dimension order. */
export function extractStatements(result: InterviewResult): IntentStatementDraft[] {
  const drafts: IntentStatementDraft[] = [];

  for (const dimension of INTENT_DIMENSIONS) {
    const exchange = result.transcript.find(
      (candidate) => candidate.question.dimension === dimension && candidate.pinned,
    );
    if (exchange !== undefined) {
      for (const text of splitStatements(exchange.answer)) {
        drafts.push({ dimension, text, source: 'answer' });
      }
      continue;
    }

    if (result.coveredByDump.includes(dimension)) {
      const cues = probeFor(dimension).cues;
      for (const text of splitStatements(result.brainDump)) {
        if (cues.some((cue) => text.toLowerCase().includes(cue))) {
          drafts.push({ dimension, text, source: 'brain-dump' });
        }
      }
    }
  }

  return drafts;
}
