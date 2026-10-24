// src/utils/run-lock.ts — Exclusive run lock: checkout tier plus per-WorkKey issue tier (#598, #3643)
//
// Every lock in the factory until this one is a *queueing* lock: contenders wait
// through withFileLock's poll/timeout path, and a stale holder is stolen under the
// ADR-0009 fenced steal-arbiter protocol. That is the right shape for a short
// critical section inside one run.
//
// It is the wrong shape for a whole run. A duplicate `factory run` against the same
// checkout used to walk straight into `setupWorktree`, which force-removes the
// deterministic per-issue worktree and branch before re-adding them — destroying a
// live run's in-flight work while both processes believed they owned the lane. A
// run lasts hours, so queueing behind it would look hung; this lock refuses instead.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';

import { defaultIsPidAlive } from '../environment/index.js';
import type { WorkKey } from '../work/work-key.js';
import { withFileLock } from './lock.js';

/** Who currently holds a run lock. `pid` comes from withFileLock's own `pid` file
 *  (authoritative); the rest comes from the `meta.json` this module writes and is
 *  absent when that file is missing or unreadable. */
export interface RunLockHolder {
  pid: number;
  startedAt?: string;
  host?: string;
  command?: string;
}

export interface RunLockOptions {
  /** Label recorded in meta.json, e.g. 'factory run'. */
  command?: string;
  /** Injectable for tests; defaults to defaultIsPidAlive. */
  isPidAlive?: (pid: number) => boolean;
  /** Forwarded to withFileLock — staleness window for a lock with no readable pid. */
  graceMs?: number;
  /** How long to keep retrying a *stale* lock before giving up. Default 250ms. Never
   *  used to wait out a live holder — that case throws before withFileLock is called. */
  staleRetryMs?: number;
  /** Poll interval inside that retry window. Default 25ms. */
  pollMs?: number;
  /** Called with the dead holder's pid when its lock is reclaimed. */
  onReclaim?: (pid: number | null) => void;
  /** Injectable clock/host for deterministic tests. */
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

/** Reads who holds `lockDir`, if anyone. Never throws — a corrupt or missing
 *  meta.json degrades to a pid-only holder (or null when there is no pid file
 *  either), it never fails the probe. */
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
    // no meta.json, or it's corrupt — pid-only holder is still a valid answer.
  }
  return holder;
}

const held = new Set<string>();

/**
 * Fences `fn` behind an exclusive lock at `lockDir` for the whole factory run. A
 * live holder is refused immediately — this never queues behind a multi-hour run,
 * unlike every other lock in the factory. A lock left by a dead holder is reclaimed
 * through the existing ADR-0009 fenced steal-arbiter protocol (delegated to
 * `withFileLock`), never re-implemented here.
 *
 * Reentrant within one process: nested acquisition of the same `lockDir` is a
 * pass-through, so `factory supervise` can hold this lock across its whole loop
 * while the `cmdRun` it invokes each cycle does not fence itself out.
 */
export async function withRunLock<T>(lockDir: string, fn: () => Promise<T>, opts: RunLockOptions = {}): Promise<T> {
  const isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;

  if (held.has(lockDir)) {
    return fn();
  }

  const holder = readRunLockHolder(lockDir);
  if (holder && isPidAlive(holder.pid)) {
    throw new RunLockHeldError(lockDir, holder);
  }

  held.add(lockDir);
  // Tracks whether `fn` itself was reached, so the catch below can tell "our own lock
  // acquisition timed out" (thrown by withFileLock without ever calling this callback)
  // apart from "fn threw an error that happens to carry a `.reason === 'timeout'` field
  // of its own" (e.g. a harness/provider timeout) — the latter must propagate unchanged,
  // never be reclassified as a lock conflict.
  let calledFn = false;
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
        calledFn = true;
        return fn();
      },
      {
        // Short and deliberate: a live holder is already rejected above, before
        // withFileLock is ever called. This window only lets two processes racing
        // to reclaim the *same dead* lock settle — it never waits out a live one.
        timeoutMs: opts.staleRetryMs ?? 250,
        pollMs: opts.pollMs ?? 25,
        graceMs: opts.graceMs,
        isPidAlive,
        onSteal: (pid) => opts.onReclaim?.(pid),
      },
    );
  } catch (err) {
    if (!calledFn && (err as { reason?: string }).reason === 'timeout') {
      throw new RunLockHeldError(lockDir, readRunLockHolder(lockDir));
    }
    throw err;
  } finally {
    held.delete(lockDir);
  }
}

/** Which lock a run takes: the checkout-wide fence (`run`, `supervise`,
 *  `local-small-overnight`) or a per-WorkKey lock (one-shot runs, #3643). */
export type RunLockScope = { kind: 'checkout' } | { kind: 'issue'; key: WorkKey };

export interface RunLockPaths {
  runLock: string;
  runLocks: string;
}

export function runLockDirFor(paths: RunLockPaths, scope: RunLockScope): string {
  return scope.kind === 'checkout' ? paths.runLock : join(paths.runLocks, scope.key);
}

/** Live holders of the checkout lock and every issue lock. Throws if the issue locks dir is unreadable (other than missing). */
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
    // no issue locks dir yet — only the checkout lock can be live. Anything else
    // (EACCES, EIO) means we cannot see issue locks, so fail loudly, not silently.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const live: Array<{ lockDir: string; holder: RunLockHolder }> = [];
  for (const lockDir of dirs) {
    const holder = readRunLockHolder(lockDir);
    if (holder && isPidAlive(holder.pid)) live.push({ lockDir, holder });
  }
  return live;
}

/**
 * Takes the lock for `scope` through `withRunLock`, then cross-checks the other tier:
 * an issue lock is refused while another process holds the checkout lock, and the
 * checkout lock is refused while another process holds any issue lock. Acquire first,
 * check second, so two racing tiers can both refuse but never both proceed.
 */
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
