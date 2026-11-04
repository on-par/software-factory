// packages/core/src/phases/ship-reentry.ts — SHIP re-entry push after a CI rework round

import { shellEscape } from '../utils/index.js';
import { type CommandRunner, describePushFailure, shortDetail, verifyRemoteHead } from './ship-git.js';
import type { ShipPhaseOptions } from './ship-options.js';
import type { ShipResult } from './ship-types.js';

export async function pushReentry(ctx: {
  run: CommandRunner;
  worktree: string;
  branch: string;
  prNumber: number | undefined;
  reentry: { prNumber: number; previousHeadSha?: string };
  log: ShipPhaseOptions['log'];
}): Promise<{ stop: ShipResult } | { watchRef: string; headSha: string }> {
  const { run, worktree, branch, prNumber, reentry, log } = ctx;
  if (prNumber !== reentry.prNumber) {
    const reason = `re-entry expected open PR #${reentry.prNumber} for ${branch} but found ${prNumber === undefined ? 'none' : `#${prNumber}`}`;
    log('ship', reason);
    return { stop: { ok: false, reason } };
  }
  let localSha: string;
  try {
    localSha = (await run('git rev-parse HEAD', { cwd: worktree })).stdout.trim();
  } catch (err) {
    const reason = `could not read local HEAD on re-entry (${shortDetail(err)})`;
    log('ship', reason);
    return { stop: { ok: false, prNumber, reason } };
  }
  if (localSha && localSha === reentry.previousHeadSha) {
    const reason = `CI rework produced no new commit on ${branch}`;
    log('ship', reason);
    return { stop: { ok: false, prNumber, ciOutcome: 'failure', reason, headSha: localSha } };
  }
  try {
    await run(`git push origin ${shellEscape(branch)}`, { cwd: worktree });
  } catch (err) {
    const { kind, detail } = describePushFailure(err);
    const reason = `re-entry push of ${branch} failed (${kind}): ${detail}`;
    log('ship', reason);
    return { stop: { ok: false, prNumber, reason } };
  }
  const remoteHead = await verifyRemoteHead(run, worktree, branch);
  if (remoteHead.status !== 'match') {
    const reason =
      remoteHead.status === 'mismatch'
        ? `remote head ${remoteHead.remoteSha} does not match local HEAD ${remoteHead.localSha} for ${branch} after re-entry push`
        : `could not verify the remote head for ${branch} after re-entry push (${remoteHead.detail})`;
    log('ship', reason);
    return { stop: { ok: false, prNumber, reason } };
  }
  const watchRef = remoteHead.remoteSha;
  const headSha = remoteHead.remoteSha;
  log('ship', `re-entry pushed ${branch} @ ${headSha}`);
  return { watchRef, headSha };
}
