// packages/product/src/interview/interview.ts — the clarifying-question loop (#470).

import { detectCoverage, isSubstantiveAnswer } from './coverage.js';
import type { DimensionProbe, IntentDimension } from './dimensions.js';
import { DIMENSION_PROBES, INTENT_DIMENSIONS, probeFor } from './dimensions.js';

export interface InterviewQuestion {
  /** 1-based position in this interview. */
  index: number;
  dimension: IntentDimension;
  text: string;
}

export interface InterviewExchange {
  question: InterviewQuestion;
  answer: string;
  /** True when the answer pinned the question's dimension. */
  pinned: boolean;
}

export type InterviewStopReason = 'pinned' | 'budget-exhausted' | 'no-questions-left';

export interface InterviewResult {
  brainDump: string;
  coveredByDump: readonly IntentDimension[];
  transcript: readonly InterviewExchange[];
  /** Dump-covered plus answer-pinned, in canonical order. */
  pinned: readonly IntentDimension[];
  /** Still open when the loop stopped, in canonical order. */
  gaps: readonly IntentDimension[];
  stopReason: InterviewStopReason;
  questionsAsked: number;
  questionBudget: number;
}

export interface InterviewDeps {
  /** Put a question to the PM and return their answer. The human/model seam. */
  ask: (question: InterviewQuestion) => Promise<string>;
  /**
   * Override the canned probe wording — the seam a model-backed interviewer plugs into
   * to target the specific assumptions in this dump. Blank output falls back to the probe.
   */
  phraseQuestion?: (probe: DimensionProbe, brainDump: string) => string | Promise<string>;
}

export interface InterviewOptions {
  /** Hard upper bound on questions asked. Default DEFAULT_QUESTION_BUDGET. */
  questionBudget?: number;
}

/** One pass over the gap list — the interviewer never re-asks, so this is its natural ceiling. */
export const DEFAULT_QUESTION_BUDGET = DIMENSION_PROBES.length;

export function formatQuestion(question: InterviewQuestion): string {
  return `Q${question.index} [${probeFor(question.dimension).label}] ${question.text}`;
}

export async function runInterview(
  brainDump: string,
  deps: InterviewDeps,
  options: InterviewOptions = {},
): Promise<InterviewResult> {
  const questionBudget = Math.max(0, Math.trunc(options.questionBudget ?? DEFAULT_QUESTION_BUDGET));
  const coveredByDump = detectCoverage(brainDump);
  const pinned = new Set<IntentDimension>(coveredByDump);
  const queue = DIMENSION_PROBES.filter((probe) => !pinned.has(probe.dimension));
  const transcript: InterviewExchange[] = [];

  let stopReason: InterviewStopReason = queue.length === 0 ? 'pinned' : 'no-questions-left';

  for (const probe of queue) {
    if (transcript.length >= questionBudget) {
      stopReason = 'budget-exhausted';
      break;
    }
    const phrased = (await deps.phraseQuestion?.(probe, brainDump))?.trim();
    const question: InterviewQuestion = {
      index: transcript.length + 1,
      dimension: probe.dimension,
      text: phrased ? phrased : probe.question,
    };
    const answer = await deps.ask(question);
    const answered = isSubstantiveAnswer(answer);
    transcript.push({ question, answer, pinned: answered });
    if (answered) {
      pinned.add(probe.dimension);
    }
  }

  if (stopReason !== 'budget-exhausted' && pinned.size === DIMENSION_PROBES.length) {
    stopReason = 'pinned';
  }

  return {
    brainDump,
    coveredByDump,
    transcript,
    pinned: INTENT_DIMENSIONS.filter((d) => pinned.has(d)),
    gaps: INTENT_DIMENSIONS.filter((d) => !pinned.has(d)),
    stopReason,
    questionsAsked: transcript.length,
    questionBudget,
  };
}
