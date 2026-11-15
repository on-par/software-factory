import { execGit } from '../utils/git-exec.js';

export async function createStackSliceBranch(opts: {
  worktree: string;
  branch: string;
  startPoint: string;
}): Promise<void> {
  await execGit(['checkout', '-B', opts.branch, opts.startPoint], { cwd: opts.worktree });
}
