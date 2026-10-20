// packages/cli/src/cli/slice-index.ts — which slice a slice or stack claim builds, decided before any worktree exists (ADR-0147, ADR-0161).

import { styleText } from 'node:util';

import type { Octokit } from '@octokit/rest';
import { GITHUB_ISSUE_SOURCE, type LocalOnlyPolicy, type SizeGateMode, type WorkRequest } from '@on-par/factory-core';
import type { CheckResumeRecord, SlicePlan } from '@on-par/factory-core/internal';
import {
  currentSlice,
  findSlicePlanComment,
  createOctokitStackSliceGateReader,
  nextStackSlice,
  readStackSliceGate,
  upsertSlicePlanComment,
  withSliceState,
} from '@on-par/factory-core/internal';

import { shipRuntime } from './ship-runtime.js';

/** Picks the lowest pending slice whose lower slice is merged, or pr-open and approved. Undefined when no slice
 *  is buildable, so the caller falls back to the plan's current slice. When the lower slice's PR is still waiting
 *  for review, rewrites the slice-plan comment (it renders the wait line), logs it and throws
 *  IssueSkippedError('stack-slice-waiting') so the lane releases the issue to the queue. */
async function claimStackSlice({
  plan,
  octokit,
  ghRepo,
  issueNum,
  log,
}: {
  plan: SlicePlan;
  octokit: Octokit;
  ghRepo: string;
  issueNum: number;
  log?: (msg: string) => void;
}): Promise<number | undefined> {
  const { errorDetail, LaneParkError, IssueSkippedError } = shipRuntime();
  const candidate = nextStackSlice(plan);
  if (candidate === undefined) return undefined;
  const lower = plan.slices.find((s) => s.index === candidate.index - 1);
  if (lower === undefined || lower.state === 'merged') return candidate.index;
  const park = (what: string, err: unknown): InstanceType<typeof LaneParkError> =>
    new LaneParkError(`${what} for #${issueNum}: ${errorDetail(err)} — parked before creating a worktree`, 'escalate');
  // The lower slice is pr-open: build on it only once its PR is approved or merged.
  let gate;
  try {
    gate = await readStackSliceGate(plan, createOctokitStackSliceGateReader(octokit, ghRepo));
  } catch (err) {
    throw park('stack approval lookup failed', err);
  }
  if (gate.status === 'merged' && gate.index === lower.index) {
    try {
      await upsertSlicePlanComment({
        octokit,
        repo: ghRepo,
        issue: issueNum,
        plan: withSliceState(plan, lower.index, 'merged', gate.prNumber),
      });
    } catch (err) {
      throw park('recording the merged slice failed', err);
    }
    return candidate.index;
  }
  if (gate.status === 'approved' && gate.index === lower.index) return candidate.index;
  const changes = gate.status === 'changes-requested' ? ' (changes requested)' : '';
  const msg = `slice ${lower.index}/${plan.slices.length} PR #${lower.prNumber} is waiting for approval or merge${changes} before slice ${candidate.index} — released to the queue`;
  try {
    await upsertSlicePlanComment({ octokit, repo: ghRepo, issue: issueNum, plan });
  } catch {
    // best-effort: the wait line is informational
  }
  log?.(msg);
  console.log(styleText('yellow', `⏸ ${msg}`));
  throw new IssueSkippedError(msg, 'stack-slice-waiting');
}

/** ADR-0147: slice k >= 2 builds on its own branch, so the slice plan is read before the worktree exists. */
export async function findSliceIndex({
  sizeGateMode,
  ctx,
  work,
  octokit,
  ghRepo,
  issueNum,
  log,
}: {
  sizeGateMode: SizeGateMode;
  ctx?: { localOnly?: LocalOnlyPolicy; resumeFrom?: CheckResumeRecord };
  work: WorkRequest;
  octokit: Octokit;
  ghRepo: string;
  issueNum: number;
  log?: (msg: string) => void;
}): Promise<number | undefined> {
  const { errorDetail, LaneParkError, IssueSkippedError } = shipRuntime();
  let sliceIndex: number | undefined;
  if (
    (sizeGateMode === 'slice' || sizeGateMode === 'stack') &&
    !ctx?.localOnly &&
    !ctx?.resumeFrom &&
    work.kind === GITHUB_ISSUE_SOURCE
  ) {
    try {
      const lookup = await findSlicePlanComment({ octokit, repo: ghRepo, issue: issueNum });
      if (lookup.status === 'found') {
        const claimed =
          sizeGateMode === 'stack'
            ? await claimStackSlice({ plan: lookup.plan, octokit, ghRepo, issueNum, log })
            : undefined;
        sliceIndex = claimed ?? currentSlice(lookup.plan)?.index;
      }
    } catch (err) {
      if (err instanceof IssueSkippedError || err instanceof LaneParkError) throw err;
      throw new LaneParkError(
        `slice plan lookup failed for #${issueNum}: ${errorDetail(err)} — parked before creating a worktree`,
        'escalate',
      );
    }
  }
  return sliceIndex;
}
