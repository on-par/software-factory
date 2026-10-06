// packages/core/src/readiness/slice-gate.ts — the PLAN pre-flight gate for ADR-0147 slice mode.
//
// In slice mode an oversized issue stays whole and no issue is ever filed (ADR-0156). This module finds the trusted slice plan comment
// (or decomposes once, without filing or commenting, and records a new plan) and tells PLAN which
// slice to plan. It never throws: every GitHub I/O failure or unusable plan comes back as a park.

import type { Octokit } from '@octokit/rest';

import type { EventKind } from '../events/kinds.js';
import type { ModelRouter } from '../router/index.js';
import { decomposeOversizedIssue } from './decompose.js';
import type { DecomposeDriverDeps } from './decompose.js';
import {
  SLICE_CAP_CEILING,
  currentSlice,
  overCapReason,
  sliceCapExceeded,
  slicePlanFromDecomposition,
} from './slice-plan.js';
import type { Slice, SlicePlan } from './slice-plan.js';
import { findSlicePlanComment, upsertSlicePlanComment } from './slice-plan-github.js';

export type SliceGateOutcome =
  | { kind: 'none' }
  | { kind: 'slice'; plan: SlicePlan; slice: Slice; created: boolean }
  | { kind: 'park'; reason: string }
  | { kind: 'over-cap'; plan: SlicePlan; reason: string };

const errorDetail = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export async function resolveSliceGate(deps: {
  issue: number;
  repo: string;
  title: string;
  body: string;
  oversized: boolean;
  sizeReason?: string;
  maxSlices: number;
  worktree: string;
  router: ModelRouter;
  octokit: Octokit;
  log: (type: EventKind, msg: string) => void;
  timeoutSeconds?: number;
  onProviderFailure?: DecomposeDriverDeps['onProviderFailure'];
}): Promise<SliceGateOutcome> {
  const { issue, repo, octokit, log } = deps;
  const reasonText = deps.sizeReason ?? 'too big';

  let lookup: Awaited<ReturnType<typeof findSlicePlanComment>>;
  try {
    lookup = await findSlicePlanComment({ octokit, repo, issue });
  } catch (error) {
    return { kind: 'park', reason: `slice plan lookup failed: ${errorDetail(error)}` };
  }

  if (lookup.status === 'invalid') {
    return {
      kind: 'park',
      reason: `slice plan comment ${lookup.commentId} on #${issue} is unreadable (${lookup.error}) — parked`,
    };
  }
  if (lookup.status === 'found') {
    if (sliceCapExceeded(lookup.plan, deps.maxSlices)) {
      return {
        kind: 'over-cap',
        plan: lookup.plan,
        reason: overCapReason(lookup.plan.slices.length, deps.maxSlices),
      };
    }
    const slice = currentSlice(lookup.plan);
    if (slice === undefined) {
      return { kind: 'park', reason: `every slice in the slice plan for #${issue} is merged — parked` };
    }
    return { kind: 'slice', plan: lookup.plan, slice, created: false };
  }
  if (!deps.oversized) return { kind: 'none' };

  const decomposed = await decomposeOversizedIssue({
    issue,
    repo,
    title: deps.title,
    body: deps.body,
    worktree: deps.worktree,
    router: deps.router,
    octokit,
    log,
    timeoutSeconds: deps.timeoutSeconds,
    onProviderFailure: deps.onProviderFailure,
    fileSubIssues: false,
    postComment: false,
  });
  const { decomposition } = decomposed;
  if (decomposition === undefined) {
    return { kind: 'park', reason: `issue exceeds the size gate (${reasonText}) — slice decomposition failed, parked` };
  }

  const built = slicePlanFromDecomposition(issue, decomposition);
  if (!built.ok) {
    if (built.reason === 'over-cap') {
      return {
        kind: 'park',
        reason: `slice decomposition produced ${built.storyCount} slices, more than the ceiling of ${SLICE_CAP_CEILING} — parked; split the issue`,
      };
    }
    return {
      kind: 'park',
      reason: `issue exceeds the size gate (${reasonText}) — decomposition produced no slices, parked`,
    };
  }

  let upserted: Awaited<ReturnType<typeof upsertSlicePlanComment>>;
  try {
    upserted = await upsertSlicePlanComment({ octokit, repo, issue, plan: built.plan });
  } catch (error) {
    return { kind: 'park', reason: `posting the slice plan failed: ${errorDetail(error)}` };
  }
  if (built.plan.slices.length > deps.maxSlices) {
    return {
      kind: 'over-cap',
      plan: built.plan,
      reason: overCapReason(built.plan.slices.length, deps.maxSlices),
    };
  }
  log(
    'size-gate-sliced',
    `issue exceeds the size gate (${reasonText}) — sliced into ${built.plan.slices.length} slice(s), slice plan comment ${upserted.commentId}`,
  );
  return { kind: 'slice', plan: built.plan, slice: built.plan.slices[0], created: true };
}
