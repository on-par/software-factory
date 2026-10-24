// packages/core/src/run/stack-slice-entry.ts — ADR-0161: stack mode builds one slice per run (#3367), on main or on its parent slice's branch.
import { upsertSlicePlanComment } from '../readiness/slice-plan-github.js';
import { parentRefForSlice, stackSliceBranch, withSliceBranchCreated } from '../readiness/slice-plan.js';
import type { PlanResult } from '../phases/plan.js';
import type { BuildRoute, RunOutcome } from './outcome.js';
import type { RunPorts, RunRequest } from './run-issue.js';
import { createStackSliceBranch } from './stack-slice-branch.js';
import { issueNumberOf } from '../work/work-key.js';

const MAIN_REF = 'origin/main';

type PlanSlice = NonNullable<PlanResult['slice']>;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** ADR-0161 (#3367): the slice below is not yet approved or merged, so the run releases the issue to queued. */
export function stackWaitOutcome(
  wait: NonNullable<PlanResult['stackWait']>,
  branch: string,
  route: BuildRoute,
): RunOutcome {
  return {
    state: 'released',
    reason: 'stack-wait',
    route,
    branch,
    reworkRounds: 0,
    prNumber: wait.prNumber,
    slice: { index: wait.index, count: wait.count },
  };
}

/** Creates slice k's branch from its parent ref and records it in the slice plan comment, before BUILD.
 *  Returns the recorded slice and the request rebound to the slice branch, or the parked outcome. */
export async function enterStackSlice(args: {
  slice: PlanSlice;
  request: RunRequest;
  ports: RunPorts;
  log: ReturnType<RunPorts['events']>;
  park: (message: string) => Promise<RunOutcome>;
}): Promise<{ outcome: RunOutcome } | { slice: PlanSlice; request: RunRequest }> {
  const { slice, request, ports, log, park } = args;
  const { plan: slicePlan, index } = slice;
  const count = slicePlan.slices.length;
  const parent = parentRefForSlice(slicePlan, index, MAIN_REF);
  if (parent === undefined) {
    return {
      outcome: await park(
        `slice ${index}/${count} of #${request.issue}: parent slice ${index - 1} has no recorded branch — parked`,
      ),
    };
  }
  const branch = stackSliceBranch(issueNumberOf(request.issue), index);
  try {
    await (ports.createSliceBranch ?? createStackSliceBranch)({
      worktree: ports.workspace.path,
      branch,
      startPoint: parent,
    });
  } catch (err) {
    return { outcome: await park(`could not create ${branch} from ${parent}: ${errorMessage(err)}`) };
  }
  const recorded = withSliceBranchCreated(slicePlan, index, branch);
  try {
    await upsertSlicePlanComment({
      octokit: ports.octokit,
      repo: request.repo,
      issue: issueNumberOf(request.issue),
      plan: recorded,
    });
  } catch (err) {
    return { outcome: await park(`could not record ${branch} in the slice plan comment: ${errorMessage(err)}`) };
  }
  log('plan', `stack slice ${index}/${count}: created ${branch} from ${parent}`);
  return {
    slice: { plan: recorded, index },
    request: { ...request, branch, ...(parent !== MAIN_REF ? { parentBaseRef: parent } : {}) },
  };
}
