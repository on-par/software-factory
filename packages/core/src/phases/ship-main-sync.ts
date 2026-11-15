import { syncLandBranch, type LandSyncOptions, type LandSyncResult } from '../land/sync.js';
import type { CommandRunner } from './ship-git.js';
import type { ShipPhaseOptions } from './ship-options.js';

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
