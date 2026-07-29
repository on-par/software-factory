// packages/product/src/judge/loop.ts — the bounded judge/rework driver (#474).

import type { Story } from '@on-par/contracts';

import type { Decomposition } from '../decompose/index.js';
import type { IntentDoc } from '../intent/index.js';
import { judgeStoryAgainstIntent, reworkStoryMechanically } from './rubric.js';
import type { JudgeVerdict, StoryJudge, StoryReworker } from './verdict.js';

export type JudgeStopReason = 'passed' | 'no-improvement' | 'max-iterations';

export interface JudgedStory {
  /** Best-scoring version seen. */
  story: Story;
  /** Verdict for that version. */
  verdict: JudgeVerdict;
  /** Rework rounds actually executed. */
  iterations: number;
  stopReason: JudgeStopReason;
  /** Initial score first, then one entry per rework round. */
  scoreHistory: readonly number[];
}

export interface JudgeReport {
  /** Story order preserved. */
  stories: readonly JudgedStory[];
  threshold: number;
  maxIterations: number;
  /** True when every stopReason is 'passed'. */
  allPassed: boolean;
}

export interface JudgeLoopDeps {
  judge?: StoryJudge;
  rework?: StoryReworker;
}

export interface JudgeLoopOptions {
  threshold?: number;
  maxIterations?: number;
}

export const DEFAULT_JUDGE_THRESHOLD = 80;
export const DEFAULT_MAX_REWORK_ITERATIONS = 3;

function resolveThreshold(options: JudgeLoopOptions): number {
  const threshold = options.threshold ?? DEFAULT_JUDGE_THRESHOLD;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
    throw new Error('judge loop: threshold must be a finite number between 0 and 100');
  }
  return threshold;
}

function resolveMaxIterations(options: JudgeLoopOptions): number {
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_REWORK_ITERATIONS;
  if (!Number.isInteger(maxIterations) || maxIterations < 0) {
    throw new Error('judge loop: maxIterations must be a non-negative integer');
  }
  return maxIterations;
}

/**
 * Judge one story, reworking it while below threshold. Structurally bounded: the only
 * loop is the for-loop over 1..maxIterations, so no injected judge/reworker (however
 * adversarial) can make this run indefinitely.
 */
export async function judgeStory(
  story: Story,
  doc: IntentDoc,
  deps: JudgeLoopDeps = {},
  options: JudgeLoopOptions = {},
): Promise<JudgedStory> {
  const judge = deps.judge ?? judgeStoryAgainstIntent;
  const rework = deps.rework ?? reworkStoryMechanically;
  const threshold = resolveThreshold(options);
  const maxIterations = resolveMaxIterations(options);

  let best = { story, verdict: await judge(story, doc) };
  const scoreHistory: number[] = [best.verdict.score];

  if (best.verdict.score >= threshold) {
    return { story: best.story, verdict: best.verdict, iterations: 0, stopReason: 'passed', scoreHistory };
  }

  for (let i = 1; i <= maxIterations; i++) {
    const candidate = await rework(best.story, best.verdict, doc);
    const verdict = await judge(candidate, doc);
    scoreHistory.push(verdict.score);

    if (verdict.score <= best.verdict.score) {
      return { story: best.story, verdict: best.verdict, iterations: i, stopReason: 'no-improvement', scoreHistory };
    }

    best = { story: candidate, verdict };
    if (verdict.score >= threshold) {
      return { story: best.story, verdict: best.verdict, iterations: i, stopReason: 'passed', scoreHistory };
    }
  }

  return {
    story: best.story,
    verdict: best.verdict,
    iterations: maxIterations,
    stopReason: 'max-iterations',
    scoreHistory,
  };
}

/** Judge every story in a decomposition, sequentially, preserving story order. */
export async function judgeDecomposition(
  decomposition: Decomposition,
  doc: IntentDoc,
  deps: JudgeLoopDeps = {},
  options: JudgeLoopOptions = {},
): Promise<JudgeReport> {
  const threshold = resolveThreshold(options);
  const maxIterations = resolveMaxIterations(options);

  const stories: JudgedStory[] = [];
  for (const story of decomposition.stories) {
    stories.push(await judgeStory(story, doc, deps, { threshold, maxIterations }));
  }

  return { stories, threshold, maxIterations, allPassed: stories.every((s) => s.stopReason === 'passed') };
}
