// src/run/slice-ship-record.ts — records a shipped ADR-0147 slice in the slice-plan comment and, in stack mode,
// points the parent slice's PR at it.

import type { Octokit } from '@octokit/rest';

import type { EventKind } from '../events/kinds.js';
import type { ShipResult } from '../phases/ship-types.js';
import { updateParentStackOrder } from '../phases/stack-order.js';
import { issueCommentSlicePlanStore, type SlicePlanStore } from '../readiness/slice-plan-store.js';
import { type SlicePlan, withSliceState } from '../readiness/slice-plan.js';
import { issueNumberOf, type WorkKey } from '../work/work-key.js';
import { readWorktreeHead } from './ci-suppression-guard.js';

/** One shipped slice recorded against the issue's (or a brief's) slice plan. */
export interface RecordShippedSliceOptions {
  octokit: Octokit;
  repo: string;
  key: WorkKey;
  branch: string;
  /** The worktree SHIP pushed from; its HEAD is the branch head SHIP verified against the remote (#4010). */
  worktree: string;
  plan: SlicePlan;
  index: number;
  ship: Pick<ShipResult, 'prNumber' | 'alreadyDelivered' | 'headSha'>;
  /** Brief PRs carry no stack-order line (shipPhase ignores the stack for inline work), so callers pass
   *  false to skip the parent-PR update: its branch names hold the brief's stand-in number (#3813). */
  stackMode: boolean;
  /** Where the plan is saved; defaults to the issue's slice-plan comment. */
  store?: SlicePlanStore;
  /** Reads the head SHA to record when SHIP reported none (#4010); defaults to readWorktreeHead. */
  readHeadSha?: (worktree: string) => Promise<string>;
  log: (type: EventKind, msg: string) => void;
}

/** Returns the failure message when the slice-plan comment write failed (the caller parks); undefined otherwise. */
export async function recordShippedSlice(opts: RecordShippedSliceOptions): Promise<string | undefined> {
  const { octokit, repo, key, branch, worktree, plan, index, ship, stackMode, store, readHeadSha, log } = opts;
  const count = plan.slices.length;
  if (ship.prNumber === undefined) {
    log('ship', `slice ${index}/${count} shipped with no PR number — slice plan not updated`);
    return undefined;
  }
  const state = ship.alreadyDelivered ? 'merged' : 'pr-open';
  // The recorded head is the head the factory pushed: `ship.headSha` is set by the CI rework re-entry
  // (pushReentry) and is already the verified remote head; otherwise the worktree HEAD is the commit
  // pushNewBranch/syncExistingPr verified equals refs/heads/<branch> on every successful ship. Never query
  // GitHub for it: a pulls.get head could be a human's commit, which the restack would then treat as
  // factory-owned (#4010).
  let headSha: string | undefined;
  if (state === 'pr-open') {
    try {
      headSha = ship.headSha ?? (await (readHeadSha ?? readWorktreeHead)(worktree));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return `slice ${index}/${count} PR #${ship.prNumber} opened but its head SHA could not be read: ${reason}`;
    }
  }
  // An injected store is a brief's slice-plan file (#3813); the default is the issue comment.
  const where = store ? 'slice plan file' : 'slice plan comment';
  try {
    await (store ?? issueCommentSlicePlanStore({ octokit, repo, issue: issueNumberOf(key) })).save(
      withSliceState(plan, index, state, ship.prNumber, branch, headSha),
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
