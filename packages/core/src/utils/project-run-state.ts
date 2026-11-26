import { resolveProjectConfigDir } from '../config/run-config-ladder.js';
import { execGit } from './git-exec.js';
import { ensureWorktreeParentExcluded } from './worktree-location.js';

async function insideWorkTree(repoRoot: string): Promise<boolean> {
  try {
    const { stdout } = await execGit(['rev-parse', '--is-inside-work-tree'], { cwd: repoRoot });
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

export async function excludeProjectRunState(
  repoRoot: string,
  stateDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if (!resolveProjectConfigDir(env) || !(await insideWorkTree(repoRoot))) return false;
  return ensureWorktreeParentExcluded(repoRoot, stateDir);
}
