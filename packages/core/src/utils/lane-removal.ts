// src/utils/lane-removal.ts — the keep / clean guard a lane applies before removing its own worktree (#3443)

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { getFactoryPaths } from '../config/index.js';
import type { EventKind } from '../events/kinds.js';
import { hasUntrackedLine } from '../worktree/worktree-gc-evidence.js';
import { decideLaneRemoval } from '../worktree/worktree-gc-decide.js';
import { findWorktreeKeep } from '../worktree/worktree-keeps.js';
import { execGit } from './git-exec.js';

export type LaneReapKeptOutcome = 'kept-record' | 'kept-dirty' | 'kept-untracked' | 'kept-unverified';

type Log = (type: EventKind, msg: string) => void;

function laneIssueFromBranch(branch: string): number | null {
  const m = /^[^/]+\/(\d+)-/.exec(branch);
  return m ? Number(m[1]) : null;
}

/** The lane's keep record and tracked-file cleanliness, decided by decideLaneRemoval. */
async function laneRemovalDecision(
  repoRoot: string,
  worktreePath: string,
  issue: number | null,
  keepsFile: string | undefined,
  log: Log,
) {
  const keep =
    issue === null ? undefined : findWorktreeKeep(keepsFile ?? getFactoryPaths(repoRoot).worktreeKeeps, issue, log);
  const status = await execGit(['status', '--porcelain', '--untracked-files=no'], { cwd: worktreePath }).catch(
    () => null,
  );
  const clean = status === null ? null : status.stdout.trim() === '';
  return {
    keep,
    decision: decideLaneRemoval({ keep: keep ? { issue: keep.issue, reason: keep.reason } : null, clean }),
  };
}

/** setupWorktree's replace step: throws, removing nothing, when the existing lane worktree has a keep
 *  record, modified tracked files, or an unverifiable state. Only a path holding a `.git` entry is judged. */
export async function assertLaneReplaceable(
  repoRoot: string,
  branch: string,
  worktreePath: string,
  opts: { issue?: number; keepsFile?: string } | undefined,
  log: Log,
): Promise<void> {
  if (!existsSync(join(worktreePath, '.git'))) return;
  const issue = opts?.issue ?? laneIssueFromBranch(branch);
  const { keep, decision } = await laneRemovalDecision(repoRoot, worktreePath, issue, opts?.keepsFile, log);
  if (decision.action === 'remove') return;
  const why =
    decision.why === 'keep-record'
      ? `it has a keep record (${keep?.reason}, since ${keep?.since})`
      : decision.why === 'dirty'
        ? 'it has uncommitted changes to tracked files'
        : 'its state could not be verified (git status failed)';
  log('worktree-gc', `kept ${worktreePath} — ${why}`);
  throw new Error(
    `setupWorktree: not replacing the existing worktree ${worktreePath} — ${why}; inspect it, or run 'factory reset ${issue ?? '<issue>'} --force' to discard it`,
  );
}

/** reapLaneWorktree's keep gate: the outcome to return when the worktree must stay, else null. */
export async function laneReapKept(
  repoRoot: string,
  worktreePath: string,
  opts: { issue: number; keepsFile?: string },
  log: Log,
): Promise<LaneReapKeptOutcome | null> {
  const { keep, decision } = await laneRemovalDecision(repoRoot, worktreePath, opts.issue, opts.keepsFile, log);
  if (decision.action === 'remove') {
    const status = await execGit(['status', '--porcelain', '--untracked-files=normal'], { cwd: worktreePath }).catch(
      () => null,
    );
    if (status === null) {
      log('warn', `could not check ${worktreePath} for untracked files — kept`);
      return 'kept-unverified';
    }
    if (hasUntrackedLine(status.stdout)) {
      log(
        'warn',
        `parked worktree ${worktreePath} has untracked files — held, not deleted; review it, or run 'factory worktree keep ${opts.issue}'`,
      );
      return 'kept-untracked';
    }
    return null;
  }
  if (decision.why === 'keep-record') {
    log(
      'worktree-gc',
      `kept ${worktreePath} — kept (${keep?.reason}); not reaping the parked lane's worktree or branch`,
    );
    return 'kept-record';
  }
  log(
    'warn',
    `parked worktree ${worktreePath} has modified tracked files — kept; review it or run 'factory worktree gc' / 'factory doctor --reconcile'`,
  );
  return 'kept-dirty';
}
