import { shellEscape } from '../utils/index.js';
import type { CommandRunner } from './ship-git.js';

/** Diff range for a PR: its real base (`main`, a stacked PR's branch, or a --base-branch), not always main. */
function prRange(base: string): string {
  const range = `origin/${base}...HEAD`;
  return /^[\w./-]+$/.test(range) ? range : shellEscape(range);
}

/** `git diff --stat` against the PR's base, for the approval gate; never part of the PR body. */
export async function computeDiffStat(run: CommandRunner, worktree: string, base: string): Promise<string> {
  try {
    const { stdout } = await run(`git diff --stat ${prRange(base)}`, { cwd: worktree });
    return stdout.split('\n').slice(-20).join('\n');
  } catch {
    return '';
  }
}

/** Raw `git diff --numstat` against the PR's base; unlike computeDiffStat, a git failure propagates to the caller. */
export async function computeNumstat(run: CommandRunner, worktree: string, base: string): Promise<string> {
  const { stdout } = await run(`git diff --numstat ${prRange(base)}`, { cwd: worktree });
  return stdout;
}
