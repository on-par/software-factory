import type { SlicePlan } from '../readiness/slice-plan.js';

export interface StackSliceReview {
  reviewerId: number | null;
  state: string;
  commitId: string | null;
}

export interface StackPullReviews {
  headSha: string;
  selfId: number | undefined;
  reviews: StackSliceReview[];
}

export interface StackSliceGateReader {
  getPullState(prNumber: number): Promise<'open' | 'merged' | 'closed'>;
  getPullReviews(prNumber: number): Promise<StackPullReviews>;
}

export type StackSliceGate =
  | { status: 'merged' | 'approved' | 'waiting' | 'changes-requested'; index: number; prNumber: number }
  | { status: 'none' };

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
  if (state === 'closed') return { status: 'waiting', index: top.index, prNumber };
  const status = readReviewApproval(await reader.getPullReviews(prNumber));
  return { status, index: top.index, prNumber };
}
