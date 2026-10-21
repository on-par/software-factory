// packages/cli/src/cli/slice-index.ts — which slice a ship run resumes at (ADR-0147, ADR-0161)

import type { Octokit } from '@octokit/rest';
import { GITHUB_ISSUE_SOURCE } from '@on-par/factory-core';
import type { LocalOnlyPolicy, SizeGateMode, WorkRequest } from '@on-par/factory-core';
import { currentSlice, findSlicePlanComment, nextStackSlice } from '@on-par/factory-core/internal';
import type { CheckResumeRecord } from '@on-par/factory-core/internal';

import { shipRuntime } from './ship-runtime.js';

/** ADR-0147: slice k >= 2 builds on its own branch, so the slice plan is read before the worktree exists. */
export async function findSliceIndex({
  sizeGateMode,
  ctx,
  work,
  octokit,
  ghRepo,
  issueNum,
}: {
  sizeGateMode: SizeGateMode;
  ctx?: { localOnly?: LocalOnlyPolicy; resumeFrom?: CheckResumeRecord };
  work: WorkRequest;
  octokit: Octokit;
  ghRepo: string;
  issueNum: number;
}): Promise<number | undefined> {
  const { errorDetail, LaneParkError } = shipRuntime();
  let sliceIndex: number | undefined;
  // ADR-0161: stack mode resumes at the lowest pending slice.
  if (
    (sizeGateMode === 'slice' || sizeGateMode === 'stack') &&
    !ctx?.localOnly &&
    !ctx?.resumeFrom &&
    work.kind === GITHUB_ISSUE_SOURCE
  ) {
    try {
      const lookup = await findSlicePlanComment({ octokit, repo: ghRepo, issue: issueNum });
      if (lookup.status === 'found') {
        const next = sizeGateMode === 'stack' ? nextStackSlice(lookup.plan) : undefined;
        sliceIndex = (next ?? currentSlice(lookup.plan))?.index;
      }
    } catch (err) {
      throw new LaneParkError(
        `slice plan lookup failed for #${issueNum}: ${errorDetail(err)} — parked before creating a worktree`,
        'escalate',
      );
    }
  }
  return sliceIndex;
}
