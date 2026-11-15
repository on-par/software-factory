import type { EventKind } from '../events/kinds.js';
import {
  acquirePortLease,
  type AcquirePortLeaseOptions,
  laneEnv,
  recordLeasePgid,
  releasePortLease,
} from '../environment/index.js';
import { ProcessGroupTracker } from '../environment/process-groups.js';
import type { SimWorkspace } from '../testing/sim/workspace.js';
import type { WorktreeSandbox } from '../utils/microvm.js';
import type { PrLookup } from '../phases/ship.js';
import type { RemoteBranchRecord } from '../types/index.js';
import { cleanupWorktree, setupWorktree } from '../utils/index.js';
import { setupInPlaceCheckout } from '../utils/in-place.js';
import type { LocalOnlyPolicy } from '../work/local-only.js';

export interface Workspace {
  readonly path: string;
  dispose(): Promise<void>;
  readonly remoteBranch?: RemoteBranchRecord;
}

export interface Environment {
  readonly port: number;
  env(): Record<string, string>;
  recordPgid(pgid: number): void;
  release(): Promise<void>;
}

export async function worktreeWorkspace(opts: {
  repoRoot: string;
  branch: string;
  worktreePath: string;
  startPoint?: string;
  log?: (type: EventKind, msg: string) => void;
  sandbox?: WorktreeSandbox;
  findOpenPr?: (branch: string) => Promise<PrLookup>;
  keepsFile?: string;
  setup?: typeof setupWorktree;
  cleanup?: typeof cleanupWorktree;
}): Promise<Workspace> {
  const setup = opts.setup ?? setupWorktree;
  const cleanup = opts.cleanup ?? cleanupWorktree;
  const result = await setup(opts.repoRoot, opts.branch, opts.worktreePath, opts.startPoint, opts.sandbox, opts.log, {
    findOpenPr: opts.findOpenPr,
    keepsFile: opts.keepsFile,
  });
  return {
    path: opts.worktreePath,
    ...(result?.remoteBranch ? { remoteBranch: result.remoteBranch } : {}),
    dispose: () => cleanup(opts.repoRoot, opts.worktreePath, opts.log, opts.sandbox),
  };
}

export async function inPlaceWorkspace(opts: {
  repoRoot: string;
  branch: string;
  log?: (type: EventKind, msg: string) => void;
  findOpenPr?: (branch: string) => Promise<PrLookup>;
  setup?: typeof setupInPlaceCheckout;
}): Promise<Workspace> {
  const setup = opts.setup ?? setupInPlaceCheckout;
  const result = await setup(opts.repoRoot, opts.branch, opts.log, { findOpenPr: opts.findOpenPr });
  return {
    path: opts.repoRoot,
    ...(result?.remoteBranch ? { remoteBranch: result.remoteBranch } : {}),
    dispose: async () => {},
  };
}

export function simWorkspace(sim: SimWorkspace): Workspace {
  return { path: sim.repoRoot, dispose: () => sim.dispose() };
}

export function localOnlyWorkspace(policy: LocalOnlyPolicy): Workspace {
  return { path: policy.workspace, dispose: async () => {} };
}

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
