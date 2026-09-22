// packages/core/src/run/ports.ts — Workspace + Environment ports (#674): names the
// workspace-provisioning and lane-environment seams runIssue depends on, and adapts
// the locked CLI worktree and local-only passthrough workspaces to the Workspace
// port. The CLI supplies its own Environment (port lease + pgid tracking + release).

import type { EventKind } from '../events/kinds.js';
import { cleanupWorktree, setupWorktree } from '../utils/index.js';
import type { LocalOnlyPolicy } from '../work/local-only.js';

/** The workspace-provisioning seam runIssue needs: a working tree the pipeline
 *  phases run in (cwd), and a teardown. */
export interface Workspace {
  /** Absolute path of the provisioned working tree (phase cwd). */
  readonly path: string;
  /** Tear down the working tree. Idempotent; a no-op for a caller-provided
   *  (local-only) workspace. */
  dispose(): Promise<void>;
}

/** Optional lane environment bundling port-lease + pgid tracking + release as
 *  one invariant: a lane either holds a fully-leased, tracked environment or it
 *  has none — never a partial state. */
export interface Environment {
  /** The leased app port injected into build/checker child processes. */
  readonly port: number;
  /** Env vars the lane's child processes get (PORT/FACTORY_APP_PORT/FACTORY_BASE_URL
   *  + the headless contract), derived from the leased port. */
  env(): Record<string, string>;
  /** Track a spawned child's process-group id in-memory AND persist it to the lease. */
  recordPgid(pgid: number): void;
  /** Kill every tracked process group, then drop the port lease. Idempotent. */
  release(): Promise<void>;
}

/** Locked-CLI-worktree adapter: provisions via setupWorktree, tears down via
 *  cleanupWorktree. Locking stays the caller's responsibility (unchanged from the
 *  CLI today); this adapter only names the seam. setup/cleanup are injectable for
 *  tests. */
export async function worktreeWorkspace(opts: {
  repoRoot: string;
  branch: string;
  worktreePath: string;
  startPoint?: string;
  log?: (type: EventKind, msg: string) => void;
  setup?: typeof setupWorktree;
  cleanup?: typeof cleanupWorktree;
}): Promise<Workspace> {
  const setup = opts.setup ?? setupWorktree;
  const cleanup = opts.cleanup ?? cleanupWorktree;
  await setup(opts.repoRoot, opts.branch, opts.worktreePath, opts.startPoint, opts.log);
  return {
    path: opts.worktreePath,
    dispose: () => cleanup(opts.repoRoot, opts.worktreePath, opts.log),
  };
}

/** Local-only passthrough adapter: the caller-provided workspace is used as-is and
 *  never torn down (factory did not create it). */
export function localOnlyWorkspace(policy: LocalOnlyPolicy): Workspace {
  return { path: policy.workspace, dispose: async () => {} };
}
