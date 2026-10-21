// src/phases/stack-approval.ts — ADR-0161 stack mode: read whether the top built slice PR is approved or merged (#3366).

import type { Octokit } from '@octokit/rest';

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

/** Octokit-backed reader for the stack slice gate; mirrors the queue preflight's reads (#3367). */
export function octokitStackSliceGateReader(octokit: Octokit, repo: string): StackSliceGateReader {
  const [owner = '', name = ''] = repo.split('/');
  let selfId: Promise<number> | undefined;
  return {
    getPullState: async (prNumber) => {
      const { data } = await octokit.rest.pulls.get({ owner, repo: name, pull_number: prNumber });
      if (data.merged || data.merged_at) return 'merged';
      return data.state === 'open' ? 'open' : 'closed';
    },
    getPullReviews: async (prNumber) => {
      const { data: pull } = await octokit.rest.pulls.get({ owner, repo: name, pull_number: prNumber });
      selfId ??= octokit.rest.users.getAuthenticated().then(({ data }) => data.id);
      const id = await selfId;
      const reviews: StackSliceReview[] = [];
      for (let page = 1; ; page++) {
        const { data } = await octokit.rest.pulls.listReviews({
          owner,
          repo: name,
          pull_number: prNumber,
          per_page: 100,
          page,
        });
        for (const r of data) {
          reviews.push({ reviewerId: r.user?.id ?? null, state: r.state, commitId: r.commit_id ?? null });
        }
        if (data.length < 100) break;
      }
      return { headSha: pull.head.sha, selfId: id, reviews };
    },
  };
}
