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
}

export class PortLeaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PortLeaseError';
  }
}

export type IsPortFreeFn = (port: number) => Promise<boolean>;

export interface AcquirePortLeaseOptions {
  registryFile: string;
  lockDir: string;
  worktreeId: string;
  branch: string;
  range: [number, number];
  pid?: number;
  isPortFree?: IsPortFreeFn;
  lockOpts?: FileLockOptions;
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

        const existing = registry.leases.find((l) => l.worktreeId === worktreeId);
        if (existing) return existing;

        const heldPorts = new Set(registry.leases.map((l) => l.port));
        const [low, high] = range;

        for (let port = low; port <= high; port++) {
          if (heldPorts.has(port)) continue;
          if (!(await isPortFree(port))) continue;

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

/** Env vars a lane's build/check harness invocations get, derived from its leased port. */
export function leaseEnv(port: number): Record<string, string> {
  return {
    PORT: String(port),
    FACTORY_APP_PORT: String(port),
    FACTORY_BASE_URL: `http://127.0.0.1:${port}`,
  };
}
