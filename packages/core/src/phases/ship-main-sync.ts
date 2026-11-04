// packages/core/src/phases/ship-main-sync.ts — merge origin/main into the branch before SHIP pushes it
//
// A lane builds from the main it started on; sibling PRs that merge meanwhile (each adding a
// CHANGELOG bullet) leave the new PR conflicting. GitHub runs no pull_request CI on a conflicting PR,
// so SHIP's CI watch timed out and stranded a draft. Syncing first, with land's CHANGELOG and ADR
// index auto-resolution, opens the PR mergeable so CI runs.

import { syncLandBranch, type LandSyncOptions, type LandSyncResult } from '../land/sync.js';
import type { CommandRunner } from './ship-git.js';
import type { ShipPhaseOptions } from './ship-options.js';

/**
 * Merges origin/main into `branch` in `worktree` and returns the SHA CHECK ran on (HEAD before the
 * merge), for the evidence pack. A sync that cannot finish is aborted, logged, and the branch ships
 * unsynced, exactly as it would have without this step.
 */
export async function syncShipBranchWithMain(ctx: {
  run: CommandRunner;
  worktree: string;
  branch: string;
  log: ShipPhaseOptions['log'];
  sync?: (opts: LandSyncOptions) => Promise<LandSyncResult>;
}): Promise<{ checkedSha?: string }> {
  const { run, worktree, branch, log } = ctx;
  const head = async () => (await run('git rev-parse HEAD', { cwd: worktree })).stdout.trim() || undefined;
  let checkedSha: string | undefined;
  try {
    checkedSha = await head();
    const result = await (ctx.sync ?? syncLandBranch)({ worktree, branch, run, log });
    if (!result.ok) {
      log('ship', `could not sync ${branch} with origin/main before push (${result.message}); pushing it unsynced`);
      return { checkedSha };
    }
    const synced = await head();
    if (synced !== checkedSha)
      log('ship', `merged origin/main into ${branch} before push (now ${synced?.slice(0, 12)})`);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log('ship', `could not sync ${branch} with origin/main before push (${detail}); pushing it unsynced`);
  }
  return { checkedSha };
}
