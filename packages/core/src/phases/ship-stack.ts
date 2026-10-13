// src/phases/ship-stack.ts — ADR-0161 stack mode SHIP: open every built slice PR and link them as one GitHub stack.

import type { Octokit } from '@octokit/rest';

import type { EventKind } from '../events/kinds.js';
import { type SlicePlan, withSliceState, withSlicesNotBuilt } from '../readiness/slice-plan.js';
import { upsertSlicePlanComment } from '../readiness/slice-plan-github.js';
import { renderPrBody } from '../reports/pr-body.js';
import type { CheckSummary } from '../types/index.js';
import { findOpenPR, isPullAlreadyExistsError } from './ship.js';

/** One built, already-pushed slice branch, bottom to top. */
export interface StackSliceInput {
  /** 1-based slice index from the slice plan. */
  index: number;
  /** Pushed head branch of this slice. */
  branch: string;
  diffStat: string;
  specBody?: string;
  risk?: string;
  checkSummary?: CheckSummary;
  reworkRounds?: number;
}

export interface StackedPr {
  index: number;
  prNumber: number;
  branch: string;
  base: string;
}

export type SliceStackResult =
  { ok: true; stackNumber: number; prs: StackedPr[] } | { ok: false; reason: string; prs: StackedPr[] };

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Opens one draft PR per built slice (slice 1 on main, slice k on slice k-1's branch), links them as one
 *  GitHub stack, and records every PR and branch in the slice-plan comment. Only the top PR closes the issue. */
export async function openSliceStack(opts: {
  octokit: Octokit;
  repo: string;
  issue: number;
  title: string;
  plan: SlicePlan;
  slices: readonly StackSliceInput[];
  /** Slice indexes the run stopped before building (ADR-0161); recorded as `not-built` in the same comment write. */
  notBuilt?: readonly number[];
  log: (type: EventKind, msg: string) => void;
}): Promise<SliceStackResult> {
  const { octokit, repo, issue, plan, log } = opts;
  const notBuilt = opts.notBuilt ?? [];
  const [owner, repoName] = repo.split('/') as [string, string];
  const count = plan.slices.length;
  const sorted = [...opts.slices].sort((a, b) => a.index - b.index);
  if (sorted.length === 0) return { ok: false, reason: 'no built slices to open', prs: [] };

  const prs: StackedPr[] = [];
  let failure: string | undefined;

  for (const [i, slice] of sorted.entries()) {
    const base = i === 0 ? 'main' : sorted[i - 1]!.branch;
    const top = slice.index === count;
    const label = `slice ${slice.index}/${count}`;
    let prNumber: number;
    try {
      const { data: pr } = await octokit.rest.pulls.create({
        owner,
        repo: repoName,
        head: slice.branch,
        base,
        title: `${opts.title} — ${label} (#${issue})`,
        draft: true,
        body: renderPrBody({
          summaryLine: `Implements ${label} of #${issue}.`,
          specBody: slice.specBody,
          diffStat: slice.diffStat,
          checkSummary: slice.checkSummary,
          reworkRounds: slice.reworkRounds,
          risk: slice.risk,
          closes: top ? issue : undefined,
          partOf: top ? undefined : issue,
        }),
      });
      prNumber = pr.number;
      log('pr_opened', `opened PR #${prNumber} for ${label} on ${slice.branch} (base ${base})`);
    } catch (err) {
      const existing = isPullAlreadyExistsError(err)
        ? await findOpenPR(octokit, owner, repoName, slice.branch)
        : undefined;
      if (existing?.status === 'found') {
        prNumber = existing.prNumber;
        log('recovered', `PR #${prNumber} already existed for ${label} on ${slice.branch}; reusing it`);
      } else {
        failure = `could not open the PR for ${label} (${slice.branch}): ${messageOf(err)}`;
        log('ship', failure);
        break;
      }
    }
    prs.push({ index: slice.index, prNumber, branch: slice.branch, base });
  }

  let stackNumber = 0;
  if (failure === undefined) {
    try {
      const { data } = await octokit.request('POST /repos/{owner}/{repo}/stacks', {
        owner,
        repo: repoName,
        pull_requests: prs.map((p) => p.prNumber),
      });
      stackNumber = (data as { number: number }).number;
      log('ship', `linked PRs ${prs.map((p) => `#${p.prNumber}`).join(', ')} as stack ${stackNumber}`);
    } catch (err) {
      failure = `could not link the slice PRs as a stack: ${messageOf(err)}`;
      log('ship', failure);
    }
  }

  if (prs.length > 0) {
    try {
      const start = notBuilt.length > 0 ? withSlicesNotBuilt(plan, Math.min(...notBuilt)) : plan;
      const recorded = prs.reduce((p, s) => withSliceState(p, s.index, 'pr-open', s.prNumber, s.branch), start);
      await upsertSlicePlanComment({ octokit, repo, issue, plan: recorded });
      log(
        'ship',
        `recorded slices ${prs.map((p) => p.index).join(', ')} as pr-open${
          notBuilt.length > 0 ? `; slices ${notBuilt.join(', ')} as not-built` : ''
        } in the slice plan comment`,
      );
    } catch (err) {
      return { ok: false, reason: `could not record the slice plan comment: ${messageOf(err)}`, prs };
    }
  }

  return failure === undefined ? { ok: true, stackNumber, prs } : { ok: false, reason: failure, prs };
}
