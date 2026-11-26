import { shellEscape } from '../utils/index.js';
import { checkRemoteIsAncestor, type CommandRunner, pushAndVerifyRemoteHead, verifyRemoteHead } from './ship-git.js';
import type { ShipPhaseOptions } from './ship-options.js';
import type { ShipResult } from './ship-types.js';

export async function syncExistingPr(ctx: {
  run: CommandRunner;
  worktree: string;
  branch: string;
  prNumber: number;
  log: ShipPhaseOptions['log'];
}): Promise<{ stop: ShipResult } | { headSha: string }> {
  const { run, worktree, branch, prNumber, log } = ctx;
  const current = await verifyRemoteHead(run, worktree, branch);
  if (current.status === 'match') {
    log(
      'ship',
      `remote head ${current.remoteSha} matches local HEAD ${current.localSha} for ${branch} — already in sync, not pushing`,
    );
    return { headSha: current.remoteSha };
  }
  if (current.status === 'mismatch') {
    const ancestry = await checkRemoteIsAncestor(run, worktree, current.remoteSha, current.localSha);
    if (ancestry.status !== 'ancestor') {
      const reason =
        ancestry.status === 'diverged'
          ? `origin/${branch} @ ${current.remoteSha} has diverged from local HEAD ${current.localSha} (remote has commits local HEAD lacks) on open PR #${prNumber} — not force-pushing`
          : `could not confirm origin/${branch} @ ${current.remoteSha} is an ancestor of local HEAD ${current.localSha} on open PR #${prNumber} (${ancestry.detail})`;
      log('ship', `${reason} — aborting before evidence`);
      return { stop: { ok: false, prNumber, reason } };
    }
  }
  const pushed = await pushAndVerifyRemoteHead(run, worktree, branch, `git push -u origin ${shellEscape(branch)}`);
  if (pushed.status !== 'pushed') {
    const reason =
      pushed.status === 'push-failed'
        ? `push of ${branch} to open PR #${prNumber} failed (${pushed.kind}): ${pushed.detail}`
        : pushed.status === 'mismatch'
          ? `remote head ${pushed.remoteSha} does not match local HEAD ${pushed.localSha} for ${branch} after push to open PR #${prNumber}`
          : `could not verify the remote head for ${branch} after push to open PR #${prNumber} (${pushed.detail})`;
    log('ship', `${reason} — aborting before evidence`);
    return { stop: { ok: false, prNumber, reason } };
  }
  log('ship', `remote head ${pushed.remoteSha} matches local HEAD ${pushed.localSha} for ${branch}`);
  return { headSha: pushed.remoteSha };
}
