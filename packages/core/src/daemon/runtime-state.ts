// src/daemon/runtime-state.ts — factoryd's on-disk runtime-state contract
// (#1177, epic #764): daemon.pid (single-instance guard), daemon.port (bound
// address record), daemon.log (append-only stdout copy), colocated with the
// registry file (~/.factory by default). The pid file is deliberately NOT the
// ADR-0009 fenced file lock: the daemon lifetime still uses pid liveness. A
// bounded, fail-fast claim critical section only serializes pid-file changes
// so competing listeners on different ports cannot share a state directory.

import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { withFileLockSync } from '../utils/lock.js';

export interface DaemonRuntimePaths {
  /** The state directory itself (default `~/.factory`). */
  dir: string;
  /** `<dir>/daemon.pid` — single-instance guard. */
  pidFile: string;
  /** `<dir>/daemon.port` — JSON `{ pid, port, host }` of the bound listener. */
  portFile: string;
  /** `<dir>/daemon.log` — timestamped copy of every daemon log line. */
  logFile: string;
}

/** Resolves the daemon runtime file paths. `dir` defaults to `<home>/.factory`
 *  — mirroring defaultRegistryPath in registry.ts, so daemon state always sits
 *  next to the registry file it serves. */
export function daemonRuntimePaths(dir?: string): DaemonRuntimePaths {
  const stateDir = dir ?? join(homedir(), '.factory');
  return {
    dir: stateDir,
    pidFile: join(stateDir, 'daemon.pid'),
    portFile: join(stateDir, 'daemon.port'),
    logFile: join(stateDir, 'daemon.log'),
  };
}

export type AcquirePidFileResult =
  /** Acquired; `stalePid` is the dead holder we displaced, null if the file
   *  was absent or held no parseable pid. */
  | { ok: true; stalePid: number | null }
  /** A live daemon holds the file; nothing was written. */
  | { ok: false; holderPid: number };

export interface AcquirePidFileOptions {
  /** The pid to record. Default `process.pid`. */
  pid?: number;
  /** Liveness probe, injectable for tests. Default: `process.kill(pid, 0)`
   *  succeeds, or fails with EPERM (alive but not ours). */
  isPidAlive?: (pid: number) => boolean;
}

/** Same semantics as lock.ts's defaultIsPidAlive: EPERM means the pid exists
 *  but belongs to another user, which still counts as alive. */
function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Fail-fast single-instance guard. A live holder refuses acquisition
 *  immediately (never waits, never steals); a dead-pid or garbage pid file is
 *  stale and is overwritten under a short mutation lock. A crash during that
 *  lock's initialization can require a retry after its bounded stale grace. */
export async function acquirePidFile(
  paths: DaemonRuntimePaths,
  opts: AcquirePidFileOptions = {},
): Promise<AcquirePidFileResult> {
  const pid = opts.pid ?? process.pid;
  const isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;
  return withFileLockSync(
    `${paths.pidFile}.claim`,
    () => {
      let holder: number | null = null;
      try {
        const raw = readFileSync(paths.pidFile, 'utf-8').trim();
        const parsed = Number(raw);
        if (/^\d+$/.test(raw) && Number.isInteger(parsed) && parsed > 0) holder = parsed;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (holder !== null && isPidAlive(holder)) return { ok: false, holderPid: holder };
      writeFileSync(paths.pidFile, `${pid}\n`, { mode: 0o600 });
      return { ok: true, stalePid: holder };
    },
    { timeoutMs: 0 },
  );
}

/** Records the actually-bound listener as JSON `{ pid, port, host }` — the
 *  shape the next slice's status/stop verbs read. */
export async function writePortFile(paths: DaemonRuntimePaths, port: number, host = '127.0.0.1'): Promise<void> {
  await writeFile(paths.portFile, JSON.stringify({ pid: process.pid, port, host }, null, 2) + '\n');
}

/** Removes daemon.pid and daemon.port — but only when the pid file still
 *  records the caller's own pid, so a crashed predecessor's cleanup can never
 *  delete a successor daemon's files. Never throws. */
export async function releaseRuntimeFiles(paths: DaemonRuntimePaths, opts: { pid?: number } = {}): Promise<void> {
  const pid = opts.pid ?? process.pid;
  try {
    withFileLockSync(
      `${paths.pidFile}.claim`,
      () => {
        const raw = readFileSync(paths.pidFile, 'utf-8').trim();
        if (Number(raw) !== pid) return;
        rmSync(paths.portFile, { force: true });
        rmSync(paths.pidFile, { force: true });
      },
      { timeoutMs: 0 },
    );
  } catch {
    // Unreadable pid file or failed rm: leave whatever is there in place.
  }
}

/** Append-only sink: one ISO-timestamped line per call. Creates the parent
 *  directory lazily on first use; swallows append errors — logging must never
 *  crash the daemon. */
export function createDaemonLogSink(logFile: string, opts: { now?: () => Date } = {}): (line: string) => void {
  let dirReady = false;
  return (line: string) => {
    try {
      if (!dirReady) {
        mkdirSync(dirname(logFile), { recursive: true });
        dirReady = true;
      }
      appendFileSync(logFile, `${(opts.now?.() ?? new Date()).toISOString()} ${line}\n`);
    } catch {
      // A full disk or permission error must not take the daemon down.
    }
  };
}
