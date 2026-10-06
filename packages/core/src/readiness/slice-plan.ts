// packages/core/src/readiness/slice-plan.ts — the pure slice plan model for ADR-0147 slice mode.
//
// An oversized issue ships as up to MAX_SLICES sequential slice PRs. The only record of slice
// state is one issue comment led by SLICE_PLAN_MARKER: a visible checklist plus a hidden data
// comment carrying base64 JSON of the whole plan, so any story text round-trips exactly. This
// module only builds, renders and parses that comment; it does no GitHub I/O.

import { StorySchema } from '@on-par/contracts';
import type { Story } from '@on-par/contracts';
import { z } from 'zod';

import type { DecompositionOutput } from './decompose.js';

/** ADR-0147 marker. The comment must start with it. Changing it needs a new ADR. */
export const SLICE_PLAN_MARKER = '<!-- factory:slice-plan v1 -->';
/** More stories than this and the work is an epic, not one issue (ADR-0147). */
export const MAX_SLICES = 5;

export type SliceState = 'pending' | 'pr-open' | 'merged';

export interface Slice {
  /** 1-based position in build order. */
  index: number;
  title: string;
  story: Story;
  state: SliceState;
  prNumber?: number;
}

export interface SlicePlan {
  /** The parent issue the slices ship under. */
  issue: number;
  /** In build order; slices[i].index === i + 1. */
  slices: readonly Slice[];
}

export type SlicePlanBuildResult =
  { ok: true; plan: SlicePlan } | { ok: false; reason: 'over-cap' | 'empty'; storyCount: number };

export type SlicePlanParseResult = { ok: true; plan: SlicePlan } | { ok: false; error: string };

const DATA_PREFIX = '<!-- factory:slice-plan-data ';
const DATA_PATTERN = /<!-- factory:slice-plan-data ([A-Za-z0-9+/=]*) -->/;

const SliceSchema = z.object({
  index: z.number().int().positive(),
  title: z.string().min(1),
  story: StorySchema,
  state: z.enum(['pending', 'pr-open', 'merged']),
  prNumber: z.number().int().positive().optional(),
});

const SlicePlanSchema = z.object({
  issue: z.number().int().positive(),
  slices: z.array(SliceSchema).min(1).max(MAX_SLICES),
});

export function slicePlanFromDecomposition(issue: number, decomposition: DecompositionOutput): SlicePlanBuildResult {
  const { stories } = decomposition;
  if (stories.length === 0) {
    return { ok: false, reason: 'empty', storyCount: 0 };
  }
  if (stories.length > MAX_SLICES) {
    return { ok: false, reason: 'over-cap', storyCount: stories.length };
  }
  return {
    ok: true,
    plan: {
      issue,
      slices: stories.map((story, i) => ({ index: i + 1, title: story.title, story, state: 'pending' as const })),
    },
  };
}

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

function stateLabel(slice: Slice): string {
  const pr = slice.prNumber;
  if (slice.state === 'pr-open') {
    return pr === undefined ? 'PR open' : `PR open #${pr}`;
  }
  if (slice.state === 'merged') {
    return pr === undefined ? 'merged' : `merged (#${pr})`;
  }
  return 'pending';
}

export function renderSlicePlanComment(plan: SlicePlan): string {
  const n = plan.slices.length;
  const checklist = plan.slices.map(
    (s) => `- [${s.state === 'merged' ? 'x' : ' '}] ${s.index}/${n}. ${oneLine(s.title)} — ${stateLabel(s)}`,
  );
  const data = Buffer.from(JSON.stringify(plan), 'utf8').toString('base64');
  return [
    SLICE_PLAN_MARKER,
    '',
    `## Slice plan for #${plan.issue}`,
    '',
    ...checklist,
    '',
    `${DATA_PREFIX}${data} -->`,
  ].join('\n');
}

export function parseSlicePlanComment(body: string): SlicePlanParseResult | null {
  if (!body.includes(SLICE_PLAN_MARKER)) {
    return null;
  }
  const match = DATA_PATTERN.exec(body);
  if (match === null) {
    return { ok: false, error: 'slice plan data comment is missing' };
  }
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(match[1] ?? '', 'base64').toString('utf8'));
  } catch {
    return { ok: false, error: 'slice plan data is not valid JSON' };
  }
  const parsed = SlicePlanSchema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, error: `slice plan data does not match the schema: ${parsed.error.message}` };
  }
  if (!parsed.data.slices.every((s, i) => s.index === i + 1)) {
    return { ok: false, error: 'slice plan indexes are not 1..n in order' };
  }
  return { ok: true, plan: parsed.data };
}

export function currentSlice(plan: SlicePlan): Slice | undefined {
  return plan.slices.find((s) => s.state !== 'merged');
}

export function withSliceState(plan: SlicePlan, index: number, state: SliceState, prNumber?: number): SlicePlan {
  if (!plan.slices.some((s) => s.index === index)) {
    throw new RangeError(`slice ${index} is not in the plan for #${plan.issue}`);
  }
  return {
    ...plan,
    slices: plan.slices.map((s) =>
      s.index === index ? { ...s, state, ...(prNumber !== undefined ? { prNumber } : {}) } : s,
    ),
  };
}
