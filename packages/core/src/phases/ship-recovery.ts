import type { Octokit } from '@octokit/rest';

import type { EventKind } from '../events/kinds.js';
import type { WorkKey } from '../work/work-key.js';
import type { CommandRunner } from './ship-git.js';
import { commitLeftoverBuildOutput } from './ship-leftover.js';
import { findMergedPR } from './ship-pr-lookup.js';
import type { ShipResult } from './ship-types.js';

export async function recoverOrStop(ctx: {
  run: CommandRunner;
  worktree: string;
  branch: string;
  issue: WorkKey | undefined;
  octokit: Octokit;
  owner: string;
  repoName: string;
  log: (type: EventKind, msg: string) => void;
}): Promise<ShipResult | undefined> {
  const { run, worktree, branch, octokit, owner, repoName, log } = ctx;
  try {
    await run('git fetch origin main', { cwd: worktree });
  } catch {
    log('ship', 'git fetch origin main failed — recovery may compare against a stale origin/main');
  }

  let recoveryState = await inspectRecoveryState(worktree, run);
  if (!recoveryState.clean) {
    const conflicts = conflictedPaths(recoveryState.statusLines);
    if (conflicts.length > 0) {
      const listed =
        conflicts.slice(0, 5).join(', ') + (conflicts.length > 5 ? ` (+${conflicts.length - 5} more)` : '');
      const reason = `worktree has merge conflicts in ${listed}`;
      log('ship', `not recovering ${branch}: ${reason} — worktree preserved`);
      return { ok: false, reason };
    }
    const committed = await commitLeftoverBuildOutput({
      run,
      worktree,
      branch,
      issue: ctx.issue,
      statusLines: recoveryState.statusLines,
      log,
    });
    if (!committed.ok) {
      log('ship', `not recovering ${branch}: ${committed.reason} — worktree preserved`);
      return { ok: false, reason: committed.reason };
    }
    recoveryState = await inspectRecoveryState(worktree, run);
    if (!recoveryState.clean) {
      const reason = 'worktree still dirty after committing leftover build output';
      log('ship', `not recovering ${branch}: ${reason} — worktree preserved`);
      return { ok: false, reason };
    }
  }
  if (recoveryState.landed || !recoveryState.ahead) {
    const mergedLookup = await findMergedPR(octokit, owner, repoName, branch);
    if (mergedLookup.status === 'error' && !recoveryState.landed) {
      const reason = `could not determine whether ${branch} was already merged (${mergedLookup.detail})`;
      log('ship', `not recovering ${branch}: ${reason}`);
      return { ok: false, reason };
    }
    const mergedPr = mergedLookup.status === 'found' ? mergedLookup.prNumber : undefined;
    if (mergedPr !== undefined || recoveryState.landed) {
      log(
        'ship',
        `not recovering ${branch}: already delivered${mergedPr !== undefined ? ` by merged PR #${mergedPr}` : ' (HEAD tree matches origin/main)'}`,
      );
      return { ok: true, prNumber: mergedPr, alreadyDelivered: true };
    }
    const reason = 'no commits ahead of origin/main';
    log('ship', `not recovering ${branch}: ${reason}`);
    return { ok: false, reason };
  }
  return undefined;
}

async function inspectRecoveryState(
  worktree: string,
  run: CommandRunner,
): Promise<{ clean: boolean; ahead: boolean; landed: boolean; statusLines: string[] }> {
  const [{ stdout: status }, { stdout: ahead }, landed] = await Promise.all([
    run('git status --porcelain', { cwd: worktree }),
    run('git rev-list --count origin/main..HEAD', { cwd: worktree }),
    run('git diff --quiet origin/main..HEAD', { cwd: worktree }).then(
      () => true,
      () => false,
    ),
  ]);
  return {
    clean: status.trim() === '',
    ahead: Number.parseInt(ahead.trim(), 10) > 0,
    landed,
    statusLines: status
      .split('\n')
      .map((l) => l.trimEnd())
      .filter((l) => l.trim() !== ''),
  };
}

function conflictedPaths(statusLines: string[]): string[] {
  return statusLines
    .filter((line) => {
      const xy = line.slice(0, 2);
      return xy.includes('U') || xy === 'AA' || xy === 'DD';
    })
    .map((line) => line.slice(3));
}
