// packages/core/src/run/stack-slice-entry.ts — ADR-0161: stack mode builds every slice in one run, each on its parent's branch.
import { upsertSlicePlanComment } from '../readiness/slice-plan-github.js';
import { parentRefForSlice, stackSliceBranch, withSliceBranchCreated } from '../readiness/slice-plan.js';
import type { PlanResult } from '../phases/plan.js';
import type { RunOutcome } from './outcome.js';
import type { RunPorts, RunRequest } from './run-issue.js';
import { createStackSliceBranch } from './stack-slice-branch.js';

type PlanSlice = NonNullable<PlanResult['slice']>;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Runs one pass per slice: while a stack-mode pass is ready and not the top slice, plans the next one. */
export async function runStackLoop(
  request: RunRequest,
  runOnce: (request: RunRequest) => Promise<RunOutcome>,
): Promise<RunOutcome> {
  let outcome = await runOnce(request);
  while (
    request.sizeGateMode === 'stack' &&
    !request.resumeFrom &&
    outcome.state === 'ready' &&
    outcome.slice !== undefined &&
    outcome.slice.index < outcome.slice.count
  ) {
    outcome = await runOnce({ ...request, sliceIndex: outcome.slice.index + 1 });
  }
  return outcome;
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
  const parent = parentRefForSlice(slicePlan, index);
  if (parent === undefined) {
    return {
      outcome: await park(
        `slice ${index}/${count} of #${request.issue}: parent slice ${index - 1} has no recorded branch — parked`,
      ),
    };
  }
  const branch = stackSliceBranch(request.issue, index);
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
    await upsertSlicePlanComment({ octokit: ports.octokit, repo: request.repo, issue: request.issue, plan: recorded });
  } catch (err) {
    return { outcome: await park(`could not record ${branch} in the slice plan comment: ${errorMessage(err)}`) };
  }
  log('plan', `stack slice ${index}/${count}: created ${branch} from ${parent}`);
  return {
    slice: { plan: recorded, index },
    request: { ...request, branch, ...(index > 1 ? { parentBaseRef: parent } : {}) },
  };
}
