// src/phases/stack-fallback.ts — ADR-0161: when the native stack API fails, fall back to slice mode for the issue.

import type { Octokit } from '@octokit/rest';

import type { EventKind } from '../events/kinds.js';
import { type SlicePlan, withSliceState, withSlicesNotBuilt } from '../readiness/slice-plan.js';
import { upsertSlicePlanComment } from '../readiness/slice-plan-github.js';
import { openSliceStack, type SliceStackResult, type StackedPr, type StackSliceInput } from './ship-stack.js';

export interface StackFallbackResult {
  mode: 'slice';
  /** Why stack mode was abandoned: the stack API error. */
  reason: string;
  /** The bottom slice PR, kept open on main as the slice-mode PR. */
  pr: StackedPr;
  /** Upper slice PRs closed so no half-linked stack stays open. */
  closedPrs: number[];
  /** Close or comment errors hit during the fallback; empty on a clean fallback. */
  cleanupErrors: string[];
}

export type ShipSliceStackResult = { mode: 'stack'; stack: SliceStackResult } | StackFallbackResult;

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Opens the slice stack; if the native stack API call fails, falls back to slice mode for this issue: keeps only
 *  the bottom PR open on main, closes the upper PRs, and resets the slice-plan comment so slices 2..n are pending. */
export async function shipSliceStack(opts: {
  octokit: Octokit;
  repo: string;
  issue: number;
  title: string;
  plan: SlicePlan;
  slices: readonly StackSliceInput[];
  /** Slice indexes the run stopped before building (ADR-0161); recorded as `not-built` in the same comment write. */
  notBuilt?: readonly number[];
  log: (type: EventKind, msg: string) => void;
}): Promise<ShipSliceStackResult> {
  const { octokit, repo, issue, plan, log } = opts;
  const notBuilt = opts.notBuilt ?? [];
  const stack = await openSliceStack(opts);
  if (stack.ok || stack.stackError === undefined || stack.prs.length === 0) return { mode: 'stack', stack };

  const [owner, repoName] = repo.split('/') as [string, string];
  const [bottom, ...upper] = stack.prs as [StackedPr, ...StackedPr[]];
  const stackError = stack.stackError;
  log(
    'stack-fallback',
    `stack mode abandoned for #${issue}: the stack API failed (${stackError}); falling back to slice mode — keeping slice ${bottom.index} PR #${bottom.prNumber} on main, closing ${
      upper.length > 0 ? upper.map((p) => `#${p.prNumber}`).join(', ') : 'no other PRs'
    }`,
  );

  const closedPrs: number[] = [];
  const cleanupErrors: string[] = [];
  for (const p of [...upper].reverse()) {
    try {
      await octokit.rest.pulls.update({ owner, repo: repoName, pull_number: p.prNumber, state: 'closed' });
      closedPrs.push(p.prNumber);
      log('ship', `closed slice ${p.index} PR #${p.prNumber}: stack fallback to slice mode`);
    } catch (err) {
      const msg = `could not close slice ${p.index} PR #${p.prNumber}: ${messageOf(err)}`;
      cleanupErrors.push(msg);
      log('ship', msg);
    }
  }

  try {
    const start = notBuilt.length > 0 ? withSlicesNotBuilt(plan, Math.min(...notBuilt)) : plan;
    const recorded = withSliceState(start, bottom.index, 'pr-open', bottom.prNumber, bottom.branch);
    await upsertSlicePlanComment({ octokit, repo, issue, plan: recorded });
    log('ship', `recorded slice ${bottom.index} as pr-open; slices 2..n back to pending (slice mode)`);
  } catch (err) {
    const msg = `could not reset the slice plan comment: ${messageOf(err)}`;
    cleanupErrors.push(msg);
    log('ship', msg);
  }

  return { mode: 'slice', reason: stackError, pr: bottom, closedPrs, cleanupErrors };
}
