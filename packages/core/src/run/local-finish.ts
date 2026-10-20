// packages/core/src/run/local-finish.ts — clean-CHECK endings for runs that never reach SHIP: local-only (#508) and --no-pr

import type { CheckSummary } from '../types/index.js';
import { upsertWorktreeKeep } from '../utils/worktree-keeps.js';
import type { BuildRoute, RunOutcome } from './outcome.js';
import type { RunPorts, RunRequest } from './run-issue.js';

export interface CleanCheck {
  route: BuildRoute;
  reworkRounds: number;
  checkSummary?: CheckSummary;
  /** Local-only run-start HEAD (#1210); the benchmark diff is taken against it. */
  diffBase?: string;
}

/** Ends a run whose CHECK passed but must not ship. Returns undefined when the run ships as usual. */
export async function finishWithoutShip(
  request: RunRequest,
  ports: RunPorts,
  log: ReturnType<RunPorts['events']>,
  { route, reworkRounds, checkSummary, diffBase }: CleanCheck,
): Promise<RunOutcome | undefined> {
  const { branch } = request;
  const worktree = ports.workspace.path;
  if (request.localOnly) {
    log('local-only-complete', `local-only run complete in ${worktree} — publishing disabled, no PR created`);
    const reportPath = await ports.writeLocalRunReport?.({ outcome: 'ready', route, branch, reworkRounds });
    await ports.writeBenchmarkArtifacts?.({
      outcome: 'ready',
      route,
      branch,
      reworkRounds,
      checkSummary,
      reportPath,
      diffBase,
    });
    return { state: 'ready', route, branch, reworkRounds };
  }
  if (request.noPr) {
    // The worktree is the run's only output: keep it out of the TTL and between-issue sweeps.
    // A failed write only loses the GC protection; the checks still passed.
    try {
      if (request.worktreeKeepsPath) {
        upsertWorktreeKeep(request.worktreeKeepsPath, {
          issue: request.issue,
          path: worktree,
          reason: 'no-pr run',
          since: new Date().toISOString(),
        });
      }
    } catch (err) {
      log(
        'warn',
        `could not write the --no-pr worktree keep record: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    log('no-pr-complete', `checks passed in ${worktree} on ${branch} — --no-pr, SHIP skipped`);
    return { state: 'ready', route, branch, reworkRounds };
  }
  return undefined;
}
