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
  tail.finally(() => {
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

    const holderPid = readHolderPid(pidPath);
    if (holderPid !== null) {
      if (!isPidAlive(holderPid)) {
        rmSync(lockDir, { recursive: true, force: true });
        opts.onSteal?.(holderPid);
        continue;
      }

      if (waitedMs >= timeoutMs) {
        throw lockTimeoutError(lockDir);
      }
      sleepSync(pollMs);
      waitedMs += pollMs;
      continue;
    }

    try {
      const stat = statSync(lockDir);
      if (Date.now() - stat.mtimeMs > graceMs) {
        rmSync(lockDir, { recursive: true, force: true });
        opts.onSteal?.(null);
        continue;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
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

    const holderPid = readHolderPid(pidPath);
    if (holderPid !== null) {
      if (!isPidAlive(holderPid)) {
        rmSync(lockDir, { recursive: true, force: true });
        opts.onSteal?.(holderPid);
        continue;
      }

      if (waitedMs >= timeoutMs) {
        throw lockTimeoutError(lockDir);
      }
      await sleep(pollMs);
      waitedMs += pollMs;
      continue;
    }

    try {
      const stat = statSync(lockDir);
      if (Date.now() - stat.mtimeMs > graceMs) {
        rmSync(lockDir, { recursive: true, force: true });
        opts.onSteal?.(null);
        continue;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }

    if (waitedMs >= timeoutMs) {
      throw lockTimeoutError(lockDir);
    }
    await sleep(pollMs);
    waitedMs += pollMs;
  }
}
