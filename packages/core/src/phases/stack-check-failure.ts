// src/phases/stack-check-failure.ts — ADR-0161 stack mode: stop at a slice that fails CHECK, open the lower slices, park.

import type { Octokit } from '@octokit/rest';

import type { EventKind } from '../events/kinds.js';
import { type SlicePlan, withSlicesNotBuilt } from '../readiness/slice-plan.js';
import { upsertSlicePlanComment } from '../readiness/slice-plan-github.js';
import type { ParkReason, RunOutcome } from '../run/outcome.js';
import { openSliceStack, type SliceStackResult, type StackSliceInput } from './ship-stack.js';

/** The slice whose CHECK still failed after rework. */
export interface StackCheckFailure {
  /** 1-based index of the failed slice. */
  index: number;
  /** Park message from CHECK, e.g. "2 check failures after 3 rework rounds". */
  message: string;
  /** Park reason CHECK chose (fail / escalate / held); defaults to 'fail'. */
  parkReason?: ParkReason;
  branch?: string;
  reworkRounds?: number;
  failureSignature?: string;
  failingChecks?: string[];
}

export interface StoppedStackResult {
  outcome: Extract<RunOutcome, { state: 'parked' }>;
  /** Human-readable park message naming the failed slice and the not-built slices. */
  message: string;
  /** Slice indexes recorded as not built: failure.index..n. */
  notBuilt: number[];
  /** The shorter stack; undefined when no slice below the failure was built. */
  stack?: SliceStackResult;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Slice k of n failed CHECK after rework: open slices 1..k-1 as a shorter native stack, record slices k..n as
 *  not built in the slice-plan comment, and return a parked outcome so the issue stays open. */
export async function shipStackStoppedAtSlice(opts: {
  octokit: Octokit;
  repo: string;
  issue: number;
  title: string;
  plan: SlicePlan;
  built: readonly StackSliceInput[];
  failure: StackCheckFailure;
  log: (type: EventKind, msg: string) => void;
}): Promise<StoppedStackResult> {
  const { octokit, repo, issue, title, plan, failure, log } = opts;
  const n = plan.slices.length;
  const k = failure.index;
  if (!plan.slices.some((s) => s.index === k)) {
    throw new RangeError(`slice ${k} is not in the plan for #${plan.issue}`);
  }
  const notBuilt = plan.slices.filter((s) => s.index >= k).map((s) => s.index);
  const lower = opts.built.filter((s) => s.index < k);

  log(
    'ship',
    `slice ${k}/${n} failed CHECK after rework — stopping the stack; slices ${notBuilt.join(', ')} not built`,
  );

  let stack: SliceStackResult | undefined;
  if (lower.length > 0) {
    stack = await openSliceStack({ octokit, repo, issue, title, plan, slices: lower, notBuilt, log });
  } else {
    try {
      await upsertSlicePlanComment({ octokit, repo, issue, plan: withSlicesNotBuilt(plan, k) });
    } catch (err) {
      log(
        'ship',
        `could not record slices ${notBuilt.join(', ')} as not-built in the slice plan comment: ${messageOf(err)}`,
      );
    }
  }

  const opened =
    lower.length > 0 ? `opened slices ${lower.map((s) => s.index).join(', ')} as a shorter stack` : 'no slices opened';
  const message =
    `slice ${k}/${n} failed CHECK after rework: ${failure.message}; ${opened}; slices ${notBuilt.join(', ')} not built` +
    (stack && !stack.ok ? ` (stack: ${stack.reason})` : '');

  const topPr = stack?.prs.at(-1)?.prNumber;
  const outcome: StoppedStackResult['outcome'] = {
    state: 'parked',
    reason: failure.parkReason ?? 'fail',
    ...(failure.branch !== undefined ? { branch: failure.branch } : {}),
    ...(failure.reworkRounds !== undefined ? { reworkRounds: failure.reworkRounds } : {}),
    ...(failure.failureSignature !== undefined ? { failureSignature: failure.failureSignature } : {}),
    ...(failure.failingChecks !== undefined ? { failingChecks: failure.failingChecks } : {}),
    ...(topPr !== undefined ? { prNumber: topPr } : {}),
  };
  return { outcome, message, notBuilt, ...(stack ? { stack } : {}) };
}
