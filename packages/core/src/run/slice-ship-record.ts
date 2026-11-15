import type { Octokit } from '@octokit/rest';

import type { EventKind } from '../events/kinds.js';
import type { ShipResult } from '../phases/ship-types.js';
import { updateParentStackOrder } from '../phases/stack-order.js';
import { issueCommentSlicePlanStore, type SlicePlanStore } from '../readiness/slice-plan-store.js';
import { type SlicePlan, withSliceState } from '../readiness/slice-plan.js';
import { issueNumberOf, type WorkKey } from '../work/work-key.js';
import { readWorktreeHead } from './ci-suppression-guard.js';

export interface RecordShippedSliceOptions {
  octokit: Octokit;
  repo: string;
  key: WorkKey;
  branch: string;
  worktree: string;
  plan: SlicePlan;
  index: number;
  ship: Pick<ShipResult, 'prNumber' | 'alreadyDelivered' | 'headSha'>;
  stackMode: boolean;
  store?: SlicePlanStore;
  readHeadSha?: (worktree: string) => Promise<string>;
  log: (type: EventKind, msg: string) => void;
}

export async function recordShippedSlice(opts: RecordShippedSliceOptions): Promise<string | undefined> {
  const { octokit, repo, key, branch, worktree, plan, index, ship, stackMode, store, readHeadSha, log } = opts;
  const count = plan.slices.length;
  if (ship.prNumber === undefined) {
    log('ship', `slice ${index}/${count} shipped with no PR number — slice plan not updated`);
    return undefined;
  }
  const state = ship.alreadyDelivered ? 'merged' : 'pr-open';
  let headSha: string | undefined;
  if (state === 'pr-open') {
    try {
      headSha = ship.headSha ?? (await (readHeadSha ?? readWorktreeHead)(worktree));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return `slice ${index}/${count} PR #${ship.prNumber} opened but its head SHA could not be read: ${reason}`;
    }
  }
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
