// src/run/slice-ship-record.ts — records a shipped ADR-0147 slice in the slice-plan comment and, in stack mode,
// points the parent slice's PR at it.

import type { Octokit } from '@octokit/rest';

import type { EventKind } from '../events/kinds.js';
import { updateParentStackOrder } from '../phases/stack-order.js';
import { upsertSlicePlanComment } from '../readiness/slice-plan-github.js';
import { type SlicePlan, withSliceState } from '../readiness/slice-plan.js';

/** Returns the failure message when the slice-plan comment write failed (the caller parks); undefined otherwise. */
export async function recordShippedSlice(opts: {
  octokit: Octokit;
  repo: string;
  issue: number;
  branch: string;
  plan: SlicePlan;
  index: number;
  ship: { prNumber?: number; alreadyDelivered?: boolean };
  stackMode: boolean;
  log: (type: EventKind, msg: string) => void;
}): Promise<string | undefined> {
  const { octokit, repo, issue, branch, plan, index, ship, stackMode, log } = opts;
  const count = plan.slices.length;
  if (ship.prNumber === undefined) {
    log('ship', `slice ${index}/${count} shipped with no PR number — slice plan not updated`);
    return undefined;
  }
  const state = ship.alreadyDelivered ? 'merged' : 'pr-open';
  try {
    await upsertSlicePlanComment({
      octokit,
      repo,
      issue,
      plan: withSliceState(plan, index, state, ship.prNumber, branch),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return `slice ${index}/${count} PR #${ship.prNumber} opened but recording it in the slice plan comment failed: ${reason}`;
  }
  log(
    'ship',
    `recorded slice ${index}/${count} as ${state} (PR #${ship.prNumber}, branch ${branch}) in the slice plan comment`,
  );
  if (stackMode && !ship.alreadyDelivered) {
    await updateParentStackOrder({ octokit, repo, plan, index, prNumber: ship.prNumber, log });
  }
  return undefined;
}
