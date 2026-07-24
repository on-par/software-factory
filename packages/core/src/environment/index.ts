// src/environment/index.ts — Port-lease registry for parallel lanes (.factory/ports.json)

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { dirname } from 'node:path';

import { type FileLockOptions, withFileLock, withGitLock } from '../utils/lock.js';

export interface PortLease {
  worktreeId: string;
  branch: string;
  port: number;
  pid: number;
  acquiredAt: string;
  /** Process-group ids of harness/checker children spawned by this lane,
   *  recorded so the startup reaper can later prove a squatting process is
   *  factory-owned before killing it. Absent on leases from older registry
   *  files (backward compatible). Capped at 64 entries. */
  pgids?: number[];
}

export class PortLeaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PortLeaseError';
  }
}

export type IsPortFreeFn = (port: number) => Promise<boolean>;

export type ReapReason = 'dead-pid' | 'missing-worktree';

export interface ReapedLease {
  lease: PortLease;
  reason: ReapReason;
}

export interface LeaseLivenessProbes {
  /** Default: defaultIsPidAlive. */
  isPidAlive?: (pid: number) => boolean;
  /** Default: existsSync on the lease's worktreeId (worktreeId IS the worktree path — see cli/index.ts:652). */
  worktreeExists?: (path: string) => boolean;
}

export interface LeaseHealth {
  lease: PortLease;
  alive: boolean;
  /** Set only when alive=false. */
  reason?: ReapReason;
  /** Set only when alive=false: true when the leased port is still bound by some process (squatter). Report only — never kill. */
  portSquatted?: boolean;
}

export interface AcquirePortLeaseOptions {
  registryFile: string;
  lockDir: string;
  worktreeId: string;
  branch: string;
  range: [number, number];
  pid?: number;
  isPortFree?: IsPortFreeFn;
  lockOpts?: FileLockOptions;
  probes?: LeaseLivenessProbes;
  onReap?: (reaped: ReapedLease) => void;
  /** Fired for each port skipped because it's busy but unleased (a squatter
   *  outside factory bookkeeping) — report only, never terminated. */
  onPortConflict?: (port: number) => void;
}

interface PortRegistry {
  version: 1;
  leases: PortLease[];
}

const EMPTY_REGISTRY: PortRegistry = { version: 1, leases: [] };

function readRegistry(registryFile: string): PortRegistry {
  if (!existsSync(registryFile)) return { ...EMPTY_REGISTRY, leases: [] };
  try {
    const raw = JSON.parse(readFileSync(registryFile, 'utf-8'));
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.leases)) {
      return { ...EMPTY_REGISTRY, leases: [] };
    }
    return { version: 1, leases: raw.leases as PortLease[] };
  } catch {
    return { ...EMPTY_REGISTRY, leases: [] };
  }
}

function writeRegistry(registryFile: string, registry: PortRegistry): void {
  mkdirSync(dirname(registryFile), { recursive: true });
  writeFileSync(registryFile, `${JSON.stringify(registry, null, 2)}\n`);
}

/** Bind-probe: true when a process could listen on `port` on 127.0.0.1 right now. */
export const defaultIsPortFree: IsPortFreeFn = (port) =>
  new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
      srv.close(() => resolve(true));
    });
  });

/** True when a process with `pid` exists (signal-0 probe; EPERM means alive but not ours). */
export function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === 'EPERM';
  }
}

function partitionLeases(
  leases: PortLease[],
  probes: LeaseLivenessProbes,
): { live: PortLease[]; reaped: ReapedLease[] } {
  const isPidAlive = probes.isPidAlive ?? defaultIsPidAlive;
  const worktreeExists = probes.worktreeExists ?? existsSync;

  const live: PortLease[] = [];
  const reaped: ReapedLease[] = [];

  for (const lease of leases) {
    if (!isPidAlive(lease.pid)) {
      reaped.push({ lease, reason: 'dead-pid' });
    } else if (!worktreeExists(lease.worktreeId)) {
      reaped.push({ lease, reason: 'missing-worktree' });
    } else {
      live.push(lease);
    }
  }

  return { live, reaped };
}

/** Acquires a stable port lease for `worktreeId`, idempotent across repeated
 *  calls for the same worktree. Locked (in-process + cross-process) so
 *  concurrent lanes never race onto the same port. */
export async function acquirePortLease(opts: AcquirePortLeaseOptions): Promise<PortLease> {
  const { registryFile, lockDir, worktreeId, branch, range, lockOpts } = opts;
  const pid = opts.pid ?? process.pid;
  const isPortFree = opts.isPortFree ?? defaultIsPortFree;

  return withGitLock(registryFile, () =>
    withFileLock(
      lockDir,
      async () => {
        const registry = readRegistry(registryFile);

        const { live, reaped } = partitionLeases(registry.leases, opts.probes ?? {});
        if (reaped.length > 0) {
          registry.leases = live;
          writeRegistry(registryFile, registry);
          for (const r of reaped) opts.onReap?.(r);
        }

        const existing = registry.leases.find((l) => l.worktreeId === worktreeId);
        if (existing) return existing;

        const heldPorts = new Set(registry.leases.map((l) => l.port));
        const [low, high] = range;

        for (let port = low; port <= high; port++) {
          if (heldPorts.has(port)) continue;
          if (!(await isPortFree(port))) {
            opts.onPortConflict?.(port);
            continue;
          }

          const lease: PortLease = { worktreeId, branch, port, pid, acquiredAt: new Date().toISOString() };
          registry.leases.push(lease);
          writeRegistry(registryFile, registry);
          return lease;
        }

        throw new PortLeaseError(
          `no free port available in range [${low}, ${high}] (${registry.leases.length} live lease(s))`,
        );
      },
      lockOpts,
    ),
  );
}

export async function releasePortLease(opts: {
  registryFile: string;
  lockDir: string;
  worktreeId: string;
  lockOpts?: FileLockOptions;
}): Promise<void> {
  const { registryFile, lockDir, worktreeId, lockOpts } = opts;

  return withGitLock(registryFile, () =>
    withFileLock(
      lockDir,
      async () => {
        const registry = readRegistry(registryFile);
        const next = registry.leases.filter((l) => l.worktreeId !== worktreeId);
        if (next.length === registry.leases.length) return;
        writeRegistry(registryFile, { version: 1, leases: next });
      },
      lockOpts,
    ),
  );
}

const MAX_TRACKED_PGIDS = 64;

/** Appends `pgid` to the lease matched by `worktreeId`, deduped, capped at
 *  64 entries to bound file growth. No-op if the lease is missing (already
 *  reaped or never acquired) — never throws. */
export async function recordLeasePgid(opts: {
  registryFile: string;
  lockDir: string;
  worktreeId: string;
  pgid: number;
  lockOpts?: FileLockOptions;
}): Promise<void> {
  const { registryFile, lockDir, worktreeId, pgid, lockOpts } = opts;

  return withGitLock(registryFile, () =>
    withFileLock(
      lockDir,
      async () => {
        const registry = readRegistry(registryFile);
        const lease = registry.leases.find((l) => l.worktreeId === worktreeId);
        if (!lease) return;

        const pgids = lease.pgids ?? [];
        if (pgids.includes(pgid)) return;

        lease.pgids = [...pgids, pgid].slice(-MAX_TRACKED_PGIDS);
        writeRegistry(registryFile, registry);
      },
      lockOpts,
    ),
  );
}

/** Removes all stale leases (dead pid or missing worktree) under the registry locks; returns what was reaped. */
export async function reapStalePortLeases(opts: {
  registryFile: string;
  lockDir: string;
  probes?: LeaseLivenessProbes;
  lockOpts?: FileLockOptions;
}): Promise<ReapedLease[]> {
  const { registryFile, lockDir, lockOpts } = opts;

  return withGitLock(registryFile, () =>
    withFileLock(
      lockDir,
      async () => {
        const registry = readRegistry(registryFile);
        const { live, reaped } = partitionLeases(registry.leases, opts.probes ?? {});
        if (reaped.length > 0) {
          writeRegistry(registryFile, { version: 1, leases: live });
        }
        return reaped;
      },
      lockOpts,
    ),
  );
}

/** Lock-free read of the current live+stale leases, used by the proxy per-request
 *  (already tolerates a missing/corrupt registry file by returning `[]`). */
export function readPortLeases(registryFile: string): PortLease[] {
  return readRegistry(registryFile).leases;
}

/** Read-only health report over the registry; used by `factory doctor`. Never mutates. */
export async function inspectPortLeases(opts: {
  registryFile: string;
  probes?: LeaseLivenessProbes;
  isPortFree?: IsPortFreeFn;
}): Promise<LeaseHealth[]> {
  const registry = readRegistry(opts.registryFile);
  const isPortFree = opts.isPortFree ?? defaultIsPortFree;
  const { live, reaped } = partitionLeases(registry.leases, opts.probes ?? {});

  const liveHealth: LeaseHealth[] = live.map((lease) => ({ lease, alive: true }));
  const staleHealth: LeaseHealth[] = await Promise.all(
    reaped.map(async (r) => ({
      lease: r.lease,
      alive: false,
      reason: r.reason,
      portSquatted: !(await isPortFree(r.lease.port)),
    })),
  );

  return [...liveHealth, ...staleHealth];
}

/** Env vars a lane's build/check harness invocations get, derived from its leased port.
 *  `baseUrl` overrides FACTORY_BASE_URL (e.g. a stable lane URL from the factory proxy);
 *  PORT/FACTORY_APP_PORT always carry the raw port regardless. */
export function leaseEnv(port: number, baseUrl?: string): Record<string, string> {
  return {
    PORT: String(port),
    FACTORY_APP_PORT: String(port),
    FACTORY_BASE_URL: baseUrl ?? `http://127.0.0.1:${port}`,
  };
}

/** Headless contract for factory-managed child processes. Explicit human
 *  opt-out: FACTORY_HEADLESS=0 in the parent environment disables injection. */
export function headlessEnv(parentEnv: Record<string, string | undefined> = process.env): Record<string, string> {
  if (parentEnv.FACTORY_HEADLESS === '0') return {};
  return { FACTORY_HEADLESS: '1', PLAYWRIGHT_HEADLESS: '1' };
}

/** Full lane environment for build/check/rework child processes: headless
 *  contract always, port-lease vars when the lane holds a lease. `baseUrl`
 *  forwards to leaseEnv (e.g. a stable lane URL from the factory proxy). */
export function laneEnv(
  port?: number,
  parentEnv: Record<string, string | undefined> = process.env,
  baseUrl?: string,
): Record<string, string> {
  return { ...headlessEnv(parentEnv), ...(port !== undefined ? leaseEnv(port, baseUrl) : {}) };
}
