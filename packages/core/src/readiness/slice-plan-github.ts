// packages/core/src/readiness/slice-plan-github.ts — GitHub I/O for the ADR-0147 slice plan comment.
//
// Finds and upserts the one issue comment led by SLICE_PLAN_MARKER. Anyone can post a comment
// with the marker, so only a marker comment written by the authenticated identity is trusted.

import type { Octokit } from '@octokit/rest';

import { markSliceMerged, parseSlicePlanComment, renderSlicePlanComment } from './slice-plan.js';
import type { SlicePlan } from './slice-plan.js';

export type SlicePlanCommentLookup =
  | { status: 'not-found' }
  | { status: 'found'; commentId: number; plan: SlicePlan }
  | { status: 'invalid'; commentId: number; error: string };

export interface SlicePlanUpsertResult {
  commentId: number;
  created: boolean;
}

const PAGE_SIZE = 100;

function splitRepo(repo: string): [string, string] {
  const [owner, name] = repo.split('/');
  return [owner, name];
}

/** First (oldest) trusted marker comment decides: found, or invalid when its data is unreadable. */
export async function findSlicePlanComment(deps: {
  octokit: Octokit;
  repo: string;
  issue: number;
}): Promise<SlicePlanCommentLookup> {
  const { octokit, repo, issue } = deps;
  const [owner, name] = splitRepo(repo);
  const { data: me } = await octokit.rest.users.getAuthenticated();
  for (let page = 1; ; page++) {
    const { data } = await octokit.rest.issues.listComments({
      owner,
      repo: name,
      issue_number: issue,
      per_page: PAGE_SIZE,
      page,
    });
    for (const comment of data) {
      if (comment.user?.id !== me.id) continue;
      const parsed = parseSlicePlanComment(comment.body ?? '');
      if (parsed === null) continue;
      if (!parsed.ok) return { status: 'invalid', commentId: comment.id, error: parsed.error };
      if (parsed.plan.issue !== issue) {
        return {
          status: 'invalid',
          commentId: comment.id,
          error: `slice plan is for #${parsed.plan.issue}, not #${issue}`,
        };
      }
      return { status: 'found', commentId: comment.id, plan: parsed.plan };
    }
    if (data.length < PAGE_SIZE) break;
  }
  return { status: 'not-found' };
}

/** Creates the plan comment, or rewrites the factory's own existing one (even an invalid one) in place. */
export async function upsertSlicePlanComment(deps: {
  octokit: Octokit;
  repo: string;
  issue: number;
  plan: SlicePlan;
}): Promise<SlicePlanUpsertResult> {
  const { octokit, repo, issue, plan } = deps;
  const [owner, name] = splitRepo(repo);
  const body = renderSlicePlanComment(plan);
  const existing = await findSlicePlanComment({ octokit, repo, issue });
  if (existing.status === 'not-found') {
    const { data } = await octokit.rest.issues.createComment({ owner, repo: name, issue_number: issue, body });
    return { commentId: data.id, created: true };
  }
  await octokit.rest.issues.updateComment({ owner, repo: name, comment_id: existing.commentId, body });
  return { commentId: existing.commentId, created: false };
}

export type SliceMergeRecordResult =
  | { status: 'recorded'; commentId: number; index: number }
  | { status: 'already-merged'; commentId: number; index: number }
  | { status: 'no-plan' }
  | { status: 'invalid'; commentId: number; error: string }
  | { status: 'no-slice'; commentId: number };

/** Marks the slice whose PR merged as merged in the trusted slice plan comment, rewriting it in place. */
export async function recordSliceMerged(deps: {
  octokit: Octokit;
  repo: string;
  issue: number;
  prNumber: number;
}): Promise<SliceMergeRecordResult> {
  const { octokit, repo, issue, prNumber } = deps;
  const lookup = await findSlicePlanComment({ octokit, repo, issue });
  if (lookup.status === 'not-found') return { status: 'no-plan' };
  if (lookup.status === 'invalid') return lookup;
  const next = markSliceMerged(lookup.plan, prNumber);
  if (next === undefined) return { status: 'no-slice', commentId: lookup.commentId };
  if (!next.changed) return { status: 'already-merged', commentId: lookup.commentId, index: next.index };
  const [owner, name] = splitRepo(repo);
  await octokit.rest.issues.updateComment({
    owner,
    repo: name,
    comment_id: lookup.commentId,
    body: renderSlicePlanComment(next.plan),
  });
  return { status: 'recorded', commentId: lookup.commentId, index: next.index };
}
