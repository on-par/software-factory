// packages/product/src/judge/verdict.ts — judge verdict types + seams (#474).

import type { Story } from '@on-par/contracts';

import type { IntentDoc } from '../intent/index.js';

/** One rubric dimension the judge evaluated. */
export interface RubricCheck {
  id: string;
  label: string;
  passed: boolean;
  /** Why it passed/failed, citing offending ids/titles. */
  note: string;
}

/** The judge's verdict on one story version. */
export interface JudgeVerdict {
  /** Integer 0-100: share of rubric checks passed. */
  score: number;
  /** Non-empty. 'All N checks passed.' or the failed checks' notes joined with '; '. */
  rationale: string;
  checks: readonly RubricCheck[];
}

/** The judge seam — an AI-backed judge plugs in here (async allowed). */
export type StoryJudge = (story: Story, doc: IntentDoc) => JudgeVerdict | Promise<JudgeVerdict>;

/** The generator/critic seam — proposes an improved story from a failing verdict. */
export type StoryReworker = (story: Story, verdict: JudgeVerdict, doc: IntentDoc) => Story | Promise<Story>;
