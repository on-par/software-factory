// packages/core/src/work/local-only.ts — opt-in local-only execution policy (#508).
import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Opt-in execution policy for one-shot local-brief runs: run PLAN/BUILD/CHECK
 *  in a caller-provided workspace and disable PR creation, merging, queue
 *  polling, and GitHub mutations. */
export interface LocalOnlyPolicy {
  readonly mode: 'local-only';
  /** Validated absolute path of the caller-provided workspace. */
  readonly workspace: string;
}

export class InvalidWorkspaceError extends Error {
  constructor(detail: string) {
    super(`invalid local-only workspace: ${detail}`);
    this.name = 'InvalidWorkspaceError';
  }
}

/** Validate a caller-provided workspace and return the local-only policy.
 *  Throws InvalidWorkspaceError BEFORE any pipeline work can begin. */
export function resolveLocalOnlyPolicy(workspaceRaw: string): LocalOnlyPolicy {
  if (typeof workspaceRaw !== 'string' || workspaceRaw.trim().length === 0) {
    throw new InvalidWorkspaceError('workspace path must be a non-empty string');
  }
  const workspace = resolve(workspaceRaw);
  let isDir = false;
  try {
    isDir = statSync(workspace).isDirectory();
  } catch {
    throw new InvalidWorkspaceError(`${workspace} does not exist`);
  }
  if (!isDir) throw new InvalidWorkspaceError(`${workspace} is not a directory`);
  // A `.git` directory (normal repo) or file (linked worktree/submodule) both count.
  if (!existsSync(join(workspace, '.git'))) {
    throw new InvalidWorkspaceError(
      `${workspace} is not an initialized git repository (no .git) — run \`git init\` there first`,
    );
  }
  return { mode: 'local-only', workspace };
}
