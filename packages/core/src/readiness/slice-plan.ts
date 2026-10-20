// packages/core/src/readiness/slice-plan.ts — the pure slice plan model for ADR-0147 slice mode.
//
// An oversized issue ships as up to SLICE_CAP_CEILING sequential slice PRs. The only record of slice
// state is one issue comment led by SLICE_PLAN_MARKER: a visible checklist plus a hidden data
// comment carrying base64 JSON of the whole plan, so any story text round-trips exactly. This
// module only builds, renders and parses that comment; it does no GitHub I/O.

import { StorySchema } from '@on-par/contracts';
import type { Story } from '@on-par/contracts';
import { z } from 'zod';

import type { DecompositionOutput } from './decompose.js';

/** ADR-0147 marker. The comment must start with it. Changing it needs a new ADR. */
export const SLICE_PLAN_MARKER = '<!-- factory:slice-plan v1 -->';
/** Hard ceiling on slices in one plan (ADR-0156): the schema bound, and the top of sizeGate.maxSlices. */
export const SLICE_CAP_CEILING = 20;
/** Effective slice cap when neither sizeGate.maxSlices nor --max-slices is set (ADR-0156). */
export const DEFAULT_MAX_SLICES = 10;

/** `not-built` is set when a stack run stops before building the slice (ADR-0161). */
export type SliceState = 'pending' | 'pr-open' | 'merged' | 'not-built';

export interface Slice {
  /** 1-based position in build order. */
  index: number;
  title: string;
  story: Story;
  state: SliceState;
  prNumber?: number;
  /** Head branch of the slice PR, once known. */
  branch?: string;
  /** Head SHA of the slice PR when the factory opened it (ADR-0161, #2674); a later change means review pushed. */
  headSha?: string;
  /** Index of the lower slice whose review changes may have invalidated this slice (ADR-0161, #2674). */
  affectedBy?: number;
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
  state: z.enum(['pending', 'pr-open', 'merged', 'not-built']),
  prNumber: z.number().int().positive().optional(),
  branch: z.string().min(1).optional(),
  headSha: z.string().min(1).optional(),
  affectedBy: z.number().int().positive().optional(),
});

const SlicePlanSchema = z.object({
  issue: z.number().int().positive(),
  slices: z.array(SliceSchema).min(1).max(SLICE_CAP_CEILING),
});

export function slicePlanFromDecomposition(issue: number, decomposition: DecompositionOutput): SlicePlanBuildResult {
  const { stories } = decomposition;
  if (stories.length === 0) {
    return { ok: false, reason: 'empty', storyCount: 0 };
  }
  if (stories.length > SLICE_CAP_CEILING) {
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

function stateLabel(slice: Slice, next?: Slice): string {
  const pr = slice.prNumber;
  if (slice.state === 'pr-open') {
    const open = pr === undefined ? 'PR open' : `PR open #${pr}`;
    return next?.state === 'pending' ? `${open} — waiting for approval or merge before slice ${next.index}` : open;
  }
  if (slice.state === 'merged') {
    return pr === undefined ? 'merged' : `merged (#${pr})`;
  }
  if (slice.state === 'not-built') return 'not built';
  return 'pending';
}

const branchSuffix = (slice: Slice): string => (slice.branch ? ` · branch \`${slice.branch}\`` : '');

const affectedSuffix = (slice: Slice): string =>
  slice.affectedBy !== undefined ? ` · affected by review changes to slice ${slice.affectedBy}` : '';

export function renderSlicePlanComment(plan: SlicePlan): string {
  const n = plan.slices.length;
  const checklist = plan.slices.map(
    (s, i) =>
      `- [${s.state === 'merged' ? 'x' : ' '}] ${s.index}/${n}. ${oneLine(s.title)} — ${stateLabel(s, plan.slices[i + 1])}${branchSuffix(s)}${affectedSuffix(s)}`,
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

/** ADR-0156: the cap applies only while every slice is pending; a started plan runs to the end. */
export function sliceCapExceeded(plan: SlicePlan, maxSlices: number): boolean {
  return plan.slices.length > maxSlices && plan.slices.every((s) => s.state === 'pending');
}

export function overCapReason(sliceCount: number, maxSlices: number): string {
  return `slice plan has ${sliceCount} slices (cap ${maxSlices}) — parked; rerun with --max-slices ${sliceCount} or split the issue`;
}

export function currentSlice(plan: SlicePlan): Slice | undefined {
  return plan.slices.find((s) => s.state !== 'merged');
}

/** ADR-0161: the deterministic head branch for slice `index` of a stacked issue. */
export function stackSliceBranch(issue: number, index: number): string {
  return `factory/${issue}-slice-${index}`;
}

/** ADR-0161: the ref a stack slice branches from when the slice below is already on main. */
export const STACK_MAIN_REF = 'origin/main';

/** ADR-0161: the lowest pending slice that can be built now: slice 1, or one whose lower slice is merged or
 *  pr-open. Undefined when none qualifies (all built, the top slice is open, or a lower slice is not-built). */
export function nextStackSlice(plan: SlicePlan): Slice | undefined {
  return plan.slices.find((s) => {
    if (s.state !== 'pending') return false;
    if (s.index === 1) return true;
    const lower = plan.slices.find((l) => l.index === s.index - 1);
    return lower?.state === 'merged' || lower?.state === 'pr-open';
  });
}

/** ADR-0161: slice 1 branches from `mainRef`; slice k from `mainRef` when slice k-1 merged, else from slice
 *  k-1's recorded branch. Undefined when that branch is not recorded or `index` is not a slice in the plan,
 *  so callers can park. */
export function parentRefForSlice(plan: SlicePlan, index: number, mainRef = STACK_MAIN_REF): string | undefined {
  if (!Number.isInteger(index) || index < 1 || index > plan.slices.length) return undefined;
  if (index === 1) return mainRef;
  const lower = plan.slices.find((s) => s.index === index - 1);
  if (lower?.state === 'merged') return mainRef;
  return lower?.branch || undefined;
}

/** ADR-0161: records slice `index`'s branch when it is created (default stackSliceBranch), keeping its state. */
export function withSliceBranchCreated(plan: SlicePlan, index: number, branch?: string): SlicePlan {
  const slice = plan.slices.find((s) => s.index === index);
  if (slice === undefined) {
    throw new RangeError(`slice ${index} is not in the plan for #${plan.issue}`);
  }
  return withSliceState(plan, index, slice.state, undefined, branch ?? stackSliceBranch(plan.issue, index));
}

export function withSliceState(
  plan: SlicePlan,
  index: number,
  state: SliceState,
  prNumber?: number,
  branch?: string,
  headSha?: string,
): SlicePlan {
  if (!plan.slices.some((s) => s.index === index)) {
    throw new RangeError(`slice ${index} is not in the plan for #${plan.issue}`);
  }
  return {
    ...plan,
    slices: plan.slices.map((s) =>
      s.index === index
        ? {
            ...s,
            state,
            ...(prNumber !== undefined ? { prNumber } : {}),
            ...(branch !== undefined ? { branch } : {}),
            ...(headSha !== undefined ? { headSha } : {}),
          }
        : s,
    ),
  };
}

/** ADR-0161: a stack run stopped at slice `fromIndex`; it and every later slice are recorded as not built. */
export function withSlicesNotBuilt(plan: SlicePlan, fromIndex: number): SlicePlan {
  if (!plan.slices.some((s) => s.index === fromIndex)) {
    throw new RangeError(`slice ${fromIndex} is not in the plan for #${plan.issue}`);
  }
  return {
    ...plan,
    slices: plan.slices.map((s) => (s.index >= fromIndex ? { ...s, state: 'not-built' as const } : s)),
  };
}

/** ADR-0161: review changed slice `changedIndex`; every open upper slice is marked as affected by it. */
export function withSlicesAffected(plan: SlicePlan, changedIndex: number): { plan: SlicePlan; affected: number[] } {
  if (!plan.slices.some((s) => s.index === changedIndex)) {
    throw new RangeError(`slice ${changedIndex} is not in the plan for #${plan.issue}`);
  }
  const hit = (s: Slice): boolean => s.index > changedIndex && s.state === 'pr-open';
  return {
    plan: { ...plan, slices: plan.slices.map((s) => (hit(s) ? { ...s, affectedBy: changedIndex } : s)) },
    affected: plan.slices.filter(hit).map((s) => s.index),
  };
}

/** Flips the slice whose PR is `prNumber` to merged; undefined when no slice carries that PR. */
export function markSliceMerged(
  plan: SlicePlan,
  prNumber: number,
): { plan: SlicePlan; index: number; changed: boolean } | undefined {
  const slice = plan.slices.find((s) => s.prNumber === prNumber);
  if (slice === undefined) return undefined;
  if (slice.state === 'merged') return { plan, index: slice.index, changed: false };
  return { plan: withSliceState(plan, slice.index, 'merged'), index: slice.index, changed: true };
}
