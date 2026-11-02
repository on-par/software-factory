// src/run/slice-ship-record.ts — records a shipped ADR-0147 slice in the slice-plan comment and, in stack mode,
// points the parent slice's PR at it.

import type { Octokit } from '@octokit/rest';

import type { EventKind } from '../events/kinds.js';
import { updateParentStackOrder } from '../phases/stack-order.js';
import { issueCommentSlicePlanStore, type SlicePlanStore } from '../readiness/slice-plan-store.js';
import { type SlicePlan, withSliceState } from '../readiness/slice-plan.js';
import { issueNumberOf, type WorkKey } from '../work/work-key.js';

/** Returns the failure message when the slice-plan comment write failed (the caller parks); undefined otherwise. */
export async function recordShippedSlice(opts: {
  octokit: Octokit;
  repo: string;
  key: WorkKey;
  branch: string;
  plan: SlicePlan;
  index: number;
  ship: { prNumber?: number; alreadyDelivered?: boolean };
  stackMode: boolean;
  /** Where the plan is saved; defaults to the issue's slice-plan comment. */
  store?: SlicePlanStore;
  log: (type: EventKind, msg: string) => void;
}): Promise<string | undefined> {
  const { octokit, repo, key, branch, plan, index, ship, stackMode, store, log } = opts;
  const count = plan.slices.length;
  if (ship.prNumber === undefined) {
    log('ship', `slice ${index}/${count} shipped with no PR number — slice plan not updated`);
    return undefined;
  }
  const state = ship.alreadyDelivered ? 'merged' : 'pr-open';
  // An injected store is a brief's slice-plan file (#3813); the default is the issue comment.
  const where = store ? 'slice plan file' : 'slice plan comment';
  try {
    await (store ?? issueCommentSlicePlanStore({ octokit, repo, issue: issueNumberOf(key) })).save(
      withSliceState(plan, index, state, ship.prNumber, branch),
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return `slice ${index}/${count} PR #${ship.prNumber} opened but recording it in the ${where} failed: ${reason}`;
  }
  log('ship', `recorded slice ${index}/${count} as ${state} (PR #${ship.prNumber}, branch ${branch}) in the ${where}`);
  if (stackMode && !ship.alreadyDelivered) {
    await updateParentStackOrder({ octokit, repo, plan, index, prNumber: ship.prNumber, log });
  }
  return undefined;
}
