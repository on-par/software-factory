import type { Octokit } from '@octokit/rest';

import { shellEscape } from '../utils/index.js';
import type { WorkKey } from '../work/work-key.js';
import { type CommandRunner, pushAndVerifyRemoteHead, readRemoteBranchSha } from './ship-git.js';
import type { ShipPhaseOptions } from './ship-options.js';
import { recoverOrStop } from './ship-recovery.js';
import type { ShipResult } from './ship-types.js';

export async function pushNewBranch(ctx: {
  run: CommandRunner;
  worktree: string;
  branch: string;
  issue: WorkKey | undefined;
  octokit: Octokit;
  owner: string;
  repoName: string;
  recordedRemoteSha?: string;
  log: ShipPhaseOptions['log'];
}): Promise<ShipResult | undefined> {
  const { run, worktree, branch, issue, octokit, owner, repoName, log } = ctx;
  const stop = await recoverOrStop({
    run,
    worktree,
    branch,
    issue,
    octokit,
    owner,
    repoName,
    log,
  });
  if (stop) return stop;

  let pushCmd = `git push -u origin ${shellEscape(branch)}`;
  const recorded = ctx.recordedRemoteSha;
  let leased = false;
  if (recorded) {
    const current = await readRemoteBranchSha(run, worktree, branch);
    if (current.status === 'unreadable') {
      const reason = `could not read origin/${branch} to check recorded SHA ${recorded} (${current.detail})`;
      log('ship', `${reason} — aborting before push`);
      return { ok: false, reason };
    }
    if (current.sha === null) {
      log('ship', `origin/${branch} recorded @ ${recorded} no longer exists — nothing to replace, plain push`);
    } else if (current.sha !== recorded) {
      const reason = `origin/${branch} moved since it was recorded: recorded ${recorded}, current ${current.sha}`;
      log('ship', `${reason} — aborting before push`);
      return { ok: false, reason };
    } else {
      pushCmd = `git push ${shellEscape(`--force-with-lease=${branch}:${recorded}`)} -u origin ${shellEscape(branch)}`;
      leased = true;
      log('ship', `replacing stale origin/${branch} @ ${recorded} with a leased push`);
    }
  }
  const pushed = await pushAndVerifyRemoteHead(run, worktree, branch, pushCmd);
  if (pushed.status === 'push-failed') {
    const pushReason = `git push failed (${pushed.kind}): ${pushed.detail}`;
    log('ship', `${pushReason} — aborting before PR creation`);
    if (leased) {
      return {
        ok: false,
        reason: `leased push of ${branch} over recorded ${recorded} was rejected (${pushed.kind})`,
      };
    }
    return { ok: false, reason: pushReason };
  }
  if (pushed.status === 'mismatch') {
    const reason = `remote head ${pushed.remoteSha} does not match local HEAD ${pushed.localSha} for ${branch}`;
    log('ship', `${reason} — aborting before PR creation`);
    return { ok: false, reason };
  }
  if (pushed.status === 'unreadable') {
    const reason = `could not verify the remote head for ${branch} (${pushed.detail}); local HEAD ${pushed.localSha ?? 'unknown'}`;
    log('ship', `${reason} — aborting before PR creation`);
    return { ok: false, reason };
  }
  log('ship', `remote head ${pushed.remoteSha} matches local HEAD ${pushed.localSha} for ${branch}`);
  return undefined;
}
