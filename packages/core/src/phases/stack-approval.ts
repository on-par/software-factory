// src/phases/stack-approval.ts — ADR-0161 stack mode: read whether the top built slice PR is approved or merged (#3366).

import type { SlicePlan } from '../readiness/slice-plan.js';

/** One PR review, reduced to what the approval gate reads. */
export interface StackSliceReview {
  /** GitHub user id of the reviewer; null when the account is gone. */
  reviewerId: number | null;
  /** GitHub review state: APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED or PENDING. */
  state: string;
  /** Commit the review was submitted on; null when GitHub omits it. */
  commitId: string | null;
}

export interface StackPullReviews {
  /** Current head SHA of the PR. */
  headSha: string;
  /** GitHub user id of the factory's own identity; its reviews never count. */
  selfId: number;
  /** Reviews in the chronological order GitHub returns them. */
  reviews: StackSliceReview[];
}

export interface StackSliceGateReader {
  getPullState(prNumber: number): Promise<'open' | 'merged' | 'closed'>;
  getPullReviews(prNumber: number): Promise<StackPullReviews>;
}

export type StackSliceGate =
  | { status: 'merged' | 'approved' | 'waiting' | 'changes-requested'; index: number; prNumber: number }
  | { status: 'none' };

/** Latest decisive review per non-self reviewer; CHANGES_REQUESTED blocks, APPROVED counts only on the head SHA. */
export function readReviewApproval(pull: StackPullReviews): 'approved' | 'waiting' | 'changes-requested' {
  const standing = new Map<number, StackSliceReview>();
  for (const review of pull.reviews) {
    if (review.reviewerId === null || review.reviewerId === pull.selfId) continue;
    if (review.state === 'DISMISSED') standing.delete(review.reviewerId);
    else if (review.state === 'APPROVED' || review.state === 'CHANGES_REQUESTED') {
      standing.set(review.reviewerId, review);
    }
  }
  const verdicts = [...standing.values()];
  if (verdicts.some((r) => r.state === 'CHANGES_REQUESTED')) return 'changes-requested';
  if (verdicts.some((r) => r.state === 'APPROVED' && r.commitId === pull.headSha)) return 'approved';
  return 'waiting';
}

/** Gate of the top built slice (highest `pr-open` or `merged`). Reader errors propagate to the caller. */
export async function readStackSliceGate(plan: SlicePlan, reader: StackSliceGateReader): Promise<StackSliceGate> {
  const n = plan.slices.length;
  const built = plan.slices.filter((s) => s.state === 'pr-open' || s.state === 'merged');
  const top = built.reduce<(typeof built)[number] | undefined>(
    (a, s) => (a === undefined || s.index > a.index ? s : a),
    undefined,
  );
  if (top === undefined) return { status: 'none' };
  if (top.prNumber === undefined) {
    throw new Error(`slice ${top.index}/${n} is ${top.state} but the slice plan records no PR number`);
  }
  const prNumber = top.prNumber;
  if (top.state === 'merged') return { status: 'merged', index: top.index, prNumber };
  const state = await reader.getPullState(prNumber);
  if (state === 'merged') return { status: 'merged', index: top.index, prNumber };
  // A closed PR cannot be built on. The bottom-up walk parks it once it becomes the lowest open layer.
  if (state === 'closed') return { status: 'waiting', index: top.index, prNumber };
  const status = readReviewApproval(await reader.getPullReviews(prNumber));
  return { status, index: top.index, prNumber };
}
