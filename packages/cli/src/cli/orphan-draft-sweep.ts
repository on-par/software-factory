// packages/cli/src/cli/orphan-draft-sweep.ts — startup wrapper for the hourly orphan factory draft sweep (#3552).

import type { Octokit } from '@octokit/rest';

import type { getFactoryPaths } from '@on-par/factory-core';
import { createOctokitQueueClient, logEvent, sweepOrphanDrafts } from '@on-par/factory-core/internal';

/** Never throws — a failure is a warn, never a reason to abort `factory run`. `getOctokit` returns
 *  undefined when there is no GitHub token, which skips the sweep. */
export async function runOrphanDraftSweep(
  paths: ReturnType<typeof getFactoryPaths>,
  ghRepo: string,
  getOctokit: () => Octokit | undefined,
): Promise<void> {
  try {
    const octokit = getOctokit();
    if (!octokit) return;
    const [owner = '', repo = ''] = ghRepo.split('/');
    const report = await sweepOrphanDrafts(
      { owner, repo, stateFile: paths.orphanDraftSweep },
      {
        octokit,
        client: createOctokitQueueClient(octokit),
        log: (type, scope, msg) => logEvent(paths.events, type, scope, msg),
      },
    );
    if (!report.throttled && report.closed.length > 0) {
      console.log(`factory: orphan draft sweep closed ${report.closed.length} draft PR(s)`);
    }
  } catch (err: any) {
    logEvent(paths.events, 'warn', 'all', `orphan draft sweep failed: ${err?.message ?? String(err)}`);
  }
}
