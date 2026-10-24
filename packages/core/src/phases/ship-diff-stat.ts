import type { CommandRunner } from './ship-git.js';

export async function computeDiffStat(run: CommandRunner, worktree: string): Promise<string> {
  try {
    const { stdout } = await run('git diff --stat origin/main...HEAD', { cwd: worktree });
    return stdout.split('\n').slice(-20).join('\n');
  } catch {
    return '';
  }
}

/** Raw `git diff --numstat`; unlike computeDiffStat, a git failure propagates to the caller. */
export async function computeNumstat(run: CommandRunner, worktree: string): Promise<string> {
  const { stdout } = await run('git diff --numstat origin/main...HEAD', { cwd: worktree });
  return stdout;
}
