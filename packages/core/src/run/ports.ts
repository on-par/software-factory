// packages/core/src/run/ports.ts — Workspace + Environment ports (#674): names the
// workspace-provisioning and lane-environment seams that today are satisfied only by
// convention, and adapts the three existing workspace impls (locked CLI worktree, sim
// throwaway workspace, local-only passthrough) plus the CLI's lease/pgid/release
// primitives to conform. No existing caller is rewired — that is a later story.

import type { EventKind } from '../events/kinds.js';
import {
  acquirePortLease,
  type AcquirePortLeaseOptions,
  laneEnv,
  recordLeasePgid,
  releasePortLease,
} from '../environment/index.js';
import { ProcessGroupTracker } from '../environment/process-groups.js';
import type { SimWorkspace } from '../sim/workspace.js';
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
  await setup(opts.repoRoot, opts.branch, opts.worktreePath, opts.startPoint ?? 'origin/main');
  return {
    path: opts.worktreePath,
    dispose: () => cleanup(opts.repoRoot, opts.worktreePath, opts.log),
  };
}

/** Sim throwaway-workspace adapter: the sim's repoRoot IS the working tree; its
 *  dispose already removes every directory it created. */
export function simWorkspace(sim: SimWorkspace): Workspace {
  return { path: sim.repoRoot, dispose: () => sim.dispose() };
}

/** Local-only passthrough adapter: the caller-provided workspace is used as-is and
 *  never torn down (factory did not create it). */
export function localOnlyWorkspace(policy: LocalOnlyPolicy): Workspace {
  return { path: policy.workspace, dispose: async () => {} };
}

/** Lane-environment adapter composing exactly the primitives the CLI orchestrates
 *  inline (acquirePortLease + ProcessGroupTracker + recordLeasePgid +
 *  releasePortLease + laneEnv). Resolves to a fully-provisioned Environment, or
 *  throws — never a partial state. */
export async function acquireLaneEnvironment(
  opts: AcquirePortLeaseOptions & { tracker?: ProcessGroupTracker; baseUrl?: string; graceMs?: number },
): Promise<Environment> {
  const tracker = opts.tracker ?? new ProcessGroupTracker();
  const lease = await acquirePortLease(opts);
  const { registryFile, lockDir, worktreeId } = opts;
  return {
    port: lease.port,
    env: () => laneEnv(lease.port, process.env, opts.baseUrl),
    recordPgid(pgid: number): void {
      tracker.track(pgid);
      void recordLeasePgid({ registryFile, lockDir, worktreeId, pgid }).catch(() => {});
    },
    async release(): Promise<void> {
      await tracker.killAll({ graceMs: opts.graceMs });
      await releasePortLease({ registryFile, lockDir, worktreeId });
    },
  };
}
