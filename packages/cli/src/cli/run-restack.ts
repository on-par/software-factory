// packages/cli/src/cli/run-restack.ts — the lane's restack hook: load the trusted slice plan, restack above a merged slice (#3368)

import type { Octokit } from '@octokit/rest';
import {
  findSlicePlanComment,
  restackAfterSquashMerge,
  type StackRestackOutcome,
  upsertSlicePlanComment,
} from '@on-par/factory-core/internal';

export async function restackFromSlicePlan(opts: {
  octokit: Octokit;
  repo: string;
  repoRoot: string;
  issue: number;
  merged: { index: number; prNumber: number };
  restack?: typeof restackAfterSquashMerge;
}): Promise<StackRestackOutcome> {
  const { octokit, repo, repoRoot, issue, merged, restack = restackAfterSquashMerge } = opts;
  const lookup = await findSlicePlanComment({ octokit, repo, issue });
  if (lookup.status === 'not-found') return { status: 'nothing', reason: 'no slice plan to restack' };
  if (lookup.status === 'invalid') {
    return { status: 'park', reason: 'slice plan unavailable for restack', index: merged.index, files: [] };
  }
  return restack({
    repoRoot,
    octokit,
    repo,
    plan: lookup.plan,
    mergedIndex: merged.index,
    mergedPrNumber: merged.prNumber,
    savePlan: (plan) => upsertSlicePlanComment({ octokit, repo, issue, plan }).then(() => {}),
  });
}
