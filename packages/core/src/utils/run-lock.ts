import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';

import { defaultIsPidAlive } from '../environment/index.js';
import type { WorkKey } from '../work/work-key.js';
import { withFileLock } from './lock.js';

const DEFAULT_DEAD_LOCK_RECLAIM_WINDOW_MS = 250;
const DEFAULT_POLL_MS = 25;

export interface RunLockHolder {
  pid: number;
  startedAt?: string;
  host?: string;
  command?: string;
}

export interface RunLockOptions {
  command?: string;
  isPidAlive?: (pid: number) => boolean;
  graceMs?: number;
  staleRetryMs?: number;
  pollMs?: number;
  onReclaim?: (pid: number | null) => void;
  now?: () => Date;
  hostnameFn?: () => string;
}

export class RunLockHeldError extends Error {
  readonly lockDir: string;
  readonly holder: RunLockHolder | null;

  constructor(lockDir: string, holder: RunLockHolder | null) {
    super(
      holder
        ? `run lock ${lockDir} is held by a live factory run (pid ${holder.pid}${
            holder.command ? `, ${holder.command}` : ''
          }${holder.startedAt ? `, started ${holder.startedAt}` : ''}${holder.host ? ` on ${holder.host}` : ''})`
        : `run lock ${lockDir} is held by another factory run`,
    );
    this.name = 'RunLockHeldError';
    this.lockDir = lockDir;
    this.holder = holder;
  }
}

export function readRunLockHolder(lockDir: string): RunLockHolder | null {
  let pid: number | null = null;
  try {
    const raw = readFileSync(join(lockDir, 'pid'), 'utf-8').trim();
    const parsed = Number(raw);
    pid = Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  } catch {
    pid = null;
  }
  if (pid === null) return null;

  const holder: RunLockHolder = { pid };
  try {
    const meta = JSON.parse(readFileSync(join(lockDir, 'meta.json'), 'utf-8')) as Record<string, unknown>;
    if (typeof meta.startedAt === 'string') holder.startedAt = meta.startedAt;
    if (typeof meta.host === 'string') holder.host = meta.host;
    if (typeof meta.command === 'string') holder.command = meta.command;
  } catch {
    return holder;
  }
  return holder;
}

const lockDirsHeldByThisProcess = new Set<string>();

export async function withRunLock<T>(lockDir: string, fn: () => Promise<T>, opts: RunLockOptions = {}): Promise<T> {
  const isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;

  if (lockDirsHeldByThisProcess.has(lockDir)) {
    return fn();
  }

  const holder = readRunLockHolder(lockDir);
  if (holder && isPidAlive(holder.pid)) {
    throw new RunLockHeldError(lockDir, holder);
  }

  lockDirsHeldByThisProcess.add(lockDir);
  let lockAcquired = false;
  try {
    return await withFileLock(
      lockDir,
      async () => {
        writeFileSync(
          join(lockDir, 'meta.json'),
          JSON.stringify({
            pid: process.pid,
            startedAt: (opts.now ?? (() => new Date()))().toISOString(),
            host: (opts.hostnameFn ?? hostname)(),
            command: opts.command,
          }) + '\n',
        );
        lockAcquired = true;
        return fn();
      },
      {
        timeoutMs: opts.staleRetryMs ?? DEFAULT_DEAD_LOCK_RECLAIM_WINDOW_MS,
        pollMs: opts.pollMs ?? DEFAULT_POLL_MS,
        graceMs: opts.graceMs,
        isPidAlive,
        onSteal: (pid) => opts.onReclaim?.(pid),
      },
    );
  } catch (err) {
    if (!lockAcquired && (err as { reason?: string }).reason === 'timeout') {
      throw new RunLockHeldError(lockDir, readRunLockHolder(lockDir));
    }
    throw err;
  } finally {
    lockDirsHeldByThisProcess.delete(lockDir);
  }
}

export type RunLockScope = { kind: 'checkout' } | { kind: 'issue'; key: WorkKey };

export interface RunLockPaths {
  runLock: string;
  runLocks: string;
}

export function runLockDirFor(paths: RunLockPaths, scope: RunLockScope): string {
  return scope.kind === 'checkout' ? paths.runLock : join(paths.runLocks, scope.key);
}

export function listLiveRunLocks(
  paths: RunLockPaths,
  isPidAlive: (pid: number) => boolean = defaultIsPidAlive,
): Array<{ lockDir: string; holder: RunLockHolder }> {
  const dirs = [paths.runLock];
  try {
    for (const entry of readdirSync(paths.runLocks, { withFileTypes: true })) {
      if (entry.isDirectory()) dirs.push(join(paths.runLocks, entry.name));
    }
  } catch (err) {
    const issueLocksDirMissing = (err as NodeJS.ErrnoException).code === 'ENOENT';
    if (!issueLocksDirMissing) throw err;
  }
  const live: Array<{ lockDir: string; holder: RunLockHolder }> = [];
  for (const lockDir of dirs) {
    const holder = readRunLockHolder(lockDir);
    if (holder && isPidAlive(holder.pid)) live.push({ lockDir, holder });
  }
  return live;
}

export async function withScopedRunLock<T>(
  paths: RunLockPaths,
  scope: RunLockScope,
  fn: () => Promise<T>,
  opts: RunLockOptions = {},
): Promise<T> {
  const isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;
  const own = runLockDirFor(paths, scope);
  return withRunLock(
    own,
    async () => {
      const conflict = listLiveRunLocks(paths, isPidAlive).find(
        ({ lockDir, holder }) =>
          lockDir !== own &&
          holder.pid !== process.pid &&
          (scope.kind === 'checkout' ? lockDir !== paths.runLock : lockDir === paths.runLock),
      );
      if (conflict) throw new RunLockHeldError(conflict.lockDir, conflict.holder);
      return fn();
    },
    opts,
  );
}
