import { styleText } from 'node:util';

import type { Octokit } from '@octokit/rest';

import { LaneFileGuard, type getFactoryPaths, type QueueDiagnostic } from '@on-par/factory-core';
import { createGithubLaneClaimStalenessProbe, logEvent, resolveBranchPrefix } from '@on-par/factory-core/internal';

export function warnQueueDiagnostics(diagnostics: QueueDiagnostic[]): void {
  for (const d of diagnostics) {
    console.error(styleText('yellow', `factory: queue ${d.message} — skipped`));
  }
}

/** Startup / queue-reconcile stale lane-claim sweep (#3065). Never throws — a failure is a
 *  warn, never a reason to abort the command. `getOctokit` returns undefined when there is no
 *  GitHub token, which skips the sweep. */
export async function sweepLaneClaims(
  paths: ReturnType<typeof getFactoryPaths>,
  ghRepo: string,
  getOctokit: () => Octokit | undefined,
): Promise<void> {
  try {
    const octokit = getOctokit();
    if (!octokit) return;
    await new LaneFileGuard(paths.laneFiles).sweepStale({
      repo: ghRepo,
      isStale: createGithubLaneClaimStalenessProbe({ octokit, branchPrefix: resolveBranchPrefix() }),
      log: (type, msg) => logEvent(paths.events, type, 'all', msg),
    });
  } catch (err: any) {
    logEvent(paths.events, 'warn', 'all', `lane claim sweep failed: ${err?.message ?? String(err)}`);
  }
}
