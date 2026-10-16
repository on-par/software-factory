// packages/core/src/run/stack-slice-branch.ts — ADR-0161: create a stack slice branch from its parent ref.
import { execGit } from '../utils/git-exec.js';

/** Points `branch` at `startPoint` and checks it out in `worktree` (`git checkout -B`), so a rerun resets it. */
export async function createStackSliceBranch(opts: {
  worktree: string;
  branch: string;
  startPoint: string;
}): Promise<void> {
  await execGit(['checkout', '-B', opts.branch, opts.startPoint], { cwd: opts.worktree });
}
