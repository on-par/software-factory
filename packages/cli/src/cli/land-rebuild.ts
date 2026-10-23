// packages/cli/src/cli/land-rebuild.ts — rebuild an issue on a fresh branch when merging origin/main into its PR conflicts (#3325)

import { createFrozenPlanStore } from '@on-par/factory-core/internal';
import type { EventKind, FailurePhase, PrRefreshPayload, RunOutcome } from '@on-par/factory-core';
import type { Octokit } from '@octokit/rest';

import { LandConflictError } from './land-pr.js';
import type { LandRebuildRequiredError } from './land-pr.js';
import { shipRuntime } from './ship-runtime.js';

const REBUILD_SUFFIX = '-rebuild';

export function rebuildBranchFor(branch: string): string {
  return `${branch}${REBUILD_SUFFIX}`;
}

/** A branch that is already a rebuild is never rebuilt again: a second conflict parks. */
export function isRebuildBranch(branch: string): boolean {
  return branch.endsWith(REBUILD_SUFFIX);
}

/**
 * Ships the issue again on `<old>-rebuild` through the lane's ship (frozen spec, no PLAN), then
 * replaces the old PR. Any failure is a LandConflictError naming the stage and the conflicting paths.
 */
export async function rebuildConflictedPr(opts: {
  issue: number;
  conflict: LandRebuildRequiredError;
  ship: (rebuild: { branch: string }) => Promise<{ branch: string; outcome?: RunOutcome }>;
  replacePr: (issue: number, oldPr: number, newPr: number, paths: string[]) => Promise<void>;
  readStage: () => Promise<FailurePhase | null>;
  log: (type: EventKind, msg: string, extra?: { prRefresh?: PrRefreshPayload }) => void;
}): Promise<{ branch: string; prNumber: number }> {
  const { issue, conflict, log } = opts;
  const oldPr = conflict.prNumber;
  const newBranch = rebuildBranchFor(conflict.branch);
  const fail = (stage: string, detail: string): LandConflictError => {
    const msg = `issue #${issue}: rebuild of PR #${oldPr} after a merge-main conflict failed at ${stage}: ${detail}; conflicting paths: ${conflict.paths.join(', ')}`;
    log('conflict', msg);
    return new LandConflictError(msg);
  };
  log('land', `rebuilding PR #${oldPr} on ${newBranch} from the frozen spec after a merge-main conflict`);

  let result: { branch: string; outcome?: RunOutcome };
  try {
    result = await opts.ship({ branch: newBranch });
  } catch (err) {
    const { LaneEnvironmentPauseError, IssueSkippedError, errorDetail } = shipRuntime();
    if (err instanceof LaneEnvironmentPauseError || err instanceof IssueSkippedError) throw err;
    throw fail((await opts.readStage().catch(() => null)) ?? 'build', errorDetail(err));
  }
  const outcome = result.outcome;
  if (outcome?.state !== 'ready' || outcome.prNumber === undefined || outcome.draft) {
    throw fail('ship', `rebuild ended ${outcome?.state ?? 'without an outcome'} without a ready PR`);
  }
  const newPr = outcome.prNumber;

  await opts
    .replacePr(issue, oldPr, newPr, conflict.paths)
    .catch((err: unknown) =>
      log('warn', `could not close PR #${oldPr} after rebuilding as #${newPr}: ${shipRuntime().errorDetail(err)}`),
    );
  log(
    'pr_refresh',
    `PR #${oldPr} refreshed: mergeStateStatus=${conflict.mergeStateStatus} action=rebuild newPr=#${newPr}`,
    { prRefresh: { pr: oldPr, mergeStateStatus: conflict.mergeStateStatus, action: 'rebuild', newPr } },
  );
  return { branch: result.branch, prNumber: newPr };
}

/** Comments on the old PR linking the new one, then closes it. The branch is kept. */
export async function replaceConflictedPr(opts: {
  octokit: Octokit;
  repo: string;
  issue: number;
  oldPr: number;
  newPr: number;
  paths: string[];
}): Promise<void> {
  const { octokit, repo, issue, oldPr, newPr, paths } = opts;
  const [owner, name] = repo.split('/');
  await octokit.rest.issues.createComment({
    owner,
    repo: name,
    issue_number: oldPr,
    body: `Replaced by #${newPr}. Merging origin/main into this PR conflicted on ${paths.join(', ')}, so the factory rebuilt #${issue} from its frozen spec on a fresh branch off main. This branch is kept.`,
  });
  await octokit.rest.pulls.update({ owner, repo: name, pull_number: oldPr, state: 'closed' });
}

/** RunPorts overrides for a rebuild: the frozen spec loads whatever the body hash, and PLAN is never called. */
export function frozenPlanPorts(specPath: string) {
  return {
    planReuse: createFrozenPlanStore(specPath),
    planPhase: async (): Promise<never> => {
      throw new Error('rebuild reuses the frozen spec; PLAN is not called (#3325)');
    },
  };
}
