import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const tails = new Map<string, Promise<unknown>>();

export interface FileLockOptions {
  timeoutMs?: number;
  pollMs?: number;
  graceMs?: number;
  isPidAlive?: (pid: number) => boolean;
  onSteal?: (holderPid: number | null) => void;
}

/**
 * Serializes async work per key within this process. The next waiter proceeds
 * after the previous call settles, whether it resolves or rejects, so throwing
 * operations release the lock. Cross-process locking is intentionally out of
 * scope for the current single-process lane model.
 */
export function withGitLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(key) ?? Promise.resolve();
  const run = prev.then(
    () => fn(),
    () => fn(),
  );
  const tail = run.then(
    () => {},
    () => {},
  );

  tails.set(key, tail);
  void tail.finally(() => {
    if (tails.get(key) === tail) tails.delete(key);
  });

  return run;
}

const DEFAULT_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_POLL_MS = 5_000;
const DEFAULT_GRACE_MS = 10_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readHolderPid(pidPath: string): number | null {
  try {
    const raw = readFileSync(pidPath, 'utf-8').trim();
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

interface LockObservation {
  /** Parsed contents of the lock dir's `pid` file, or null when missing/unparseable. */
  pid: number | null;
  ino: number;
  mtimeMs: number;
}

/** One atomic-enough snapshot of who holds `lockDir`. Returns null when the dir is gone. */
function observeLock(lockDir: string): LockObservation | null {
  try {
    const stat = statSync(lockDir);
    return { pid: readHolderPid(join(lockDir, 'pid')), ino: stat.ino, mtimeMs: stat.mtimeMs };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** Suffix of the sibling directory that arbitrates a steal (see ADR-0009). */
const STEAL_ARBITER_SUFFIX = '.steal';

/**
 * Removes `lockDir` only if it is still the exact stale holder described by `observed`.
 * The check-and-remove is serialized across processes by an atomically created sibling
 * arbiter dir, so of N concurrent stealers exactly one can remove the lock. Returns true
 * when this caller removed it; false when another stealer holds the arbiter, or when the
 * lock changed identity under us (it was already stolen and re-acquired) — in both cases
 * the caller must back off and re-observe, never assume it holds the lock.
 */
function stealStaleLock(lockDir: string, observed: LockObservation, graceMs: number): boolean {
  const arbiterDir = `${lockDir}${STEAL_ARBITER_SUFFIX}`;

  try {
    mkdirSync(arbiterDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    // A stealer that died mid-steal would otherwise wedge this lock forever: reap the
    // arbiter once it is older than the grace window and let the caller retry.
    const arbiter = observeLock(arbiterDir);
    if (arbiter !== null && Date.now() - arbiter.mtimeMs > graceMs) {
      rmSync(arbiterDir, { recursive: true, force: true });
    }
    return false;
  }

  try {
    const current = observeLock(lockDir);
    if (
      current === null ||
      current.pid !== observed.pid ||
      current.ino !== observed.ino ||
      current.mtimeMs !== observed.mtimeMs
    ) {
      return false;
    }
    rmSync(lockDir, { recursive: true, force: true });
    return true;
  } finally {
    rmSync(arbiterDir, { recursive: true, force: true });
  }
}

function lockTimeoutError(lockDir: string): Error & { reason: string } {
  return Object.assign(new Error(`lock ${lockDir} stuck >30m`), { reason: 'timeout' });
}

export interface SyncFileLockOptions {
  timeoutMs?: number;
  pollMs?: number;
  graceMs?: number;
  isPidAlive?: (pid: number) => boolean;
  onSteal?: (holderPid: number | null) => void;
}

const DEFAULT_SYNC_TIMEOUT_MS = 10_000;
const DEFAULT_SYNC_POLL_MS = 5;

const sleepBuf = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms: number): void {
  Atomics.wait(sleepBuf, 0, 0, ms);
}

/**
 * Synchronous sibling of withFileLock, for callers on a synchronous hot path
 * (the event logger) that cannot become async without changing their public
 * API. Mirrors the exact same mkdir+pid on-disk protocol so sync and async
 * holders of different locks coexist safely.
 */
export function withFileLockSync<T>(lockDir: string, fn: () => T, opts: SyncFileLockOptions = {}): T {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_SYNC_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? DEFAULT_SYNC_POLL_MS;
  const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
  const isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;
  const pidPath = join(lockDir, 'pid');
  const ourPid = String(process.pid);
  let waitedMs = 0;

  mkdirSync(dirname(lockDir), { recursive: true });

  while (true) {
    let acquired = false;
    try {
      mkdirSync(lockDir);
      acquired = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }

    if (acquired) {
      try {
        writeFileSync(pidPath, ourPid);
      } catch (err) {
        rmSync(lockDir, { recursive: true, force: true });
        throw err;
      }

      try {
        return fn();
      } finally {
        if (readHolderPid(pidPath) === Number(ourPid)) {
          rmSync(lockDir, { recursive: true, force: true });
        }
      }
    }

    const observed = observeLock(lockDir);
    if (observed === null) continue; // holder released between our mkdir and our stat

    const stale = observed.pid !== null ? !isPidAlive(observed.pid) : Date.now() - observed.mtimeMs > graceMs;

    if (stale && stealStaleLock(lockDir, observed, graceMs)) {
      opts.onSteal?.(observed.pid);
      continue;
    }

    if (waitedMs >= timeoutMs) {
      throw lockTimeoutError(lockDir);
    }
    sleepSync(pollMs);
    waitedMs += pollMs;
  }
}

export async function withFileLock<T>(lockDir: string, fn: () => Promise<T>, opts: FileLockOptions = {}): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
  const isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;
  const pidPath = join(lockDir, 'pid');
  const ourPid = String(process.pid);
  let waitedMs = 0;

  mkdirSync(dirname(lockDir), { recursive: true });

  while (true) {
    let acquired = false;
    try {
      mkdirSync(lockDir);
      acquired = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }

    if (acquired) {
      try {
        writeFileSync(pidPath, ourPid);
      } catch (err) {
        rmSync(lockDir, { recursive: true, force: true });
        throw err;
      }

      try {
        return await fn();
      } finally {
        if (readHolderPid(pidPath) === Number(ourPid)) {
          rmSync(lockDir, { recursive: true, force: true });
        }
      }
    }

    const observed = observeLock(lockDir);
    if (observed === null) continue; // holder released between our mkdir and our stat

    const stale = observed.pid !== null ? !isPidAlive(observed.pid) : Date.now() - observed.mtimeMs > graceMs;

    if (stale && stealStaleLock(lockDir, observed, graceMs)) {
      opts.onSteal?.(observed.pid);
      continue;
    }

    if (waitedMs >= timeoutMs) {
      throw lockTimeoutError(lockDir);
    }
    await sleep(pollMs);
    waitedMs += pollMs;
  }
}
