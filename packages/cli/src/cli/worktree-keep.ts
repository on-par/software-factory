// packages/cli/src/cli/worktree-keep.ts — `factory worktree keep|release` and the re-queue release (#3318)

import { existsSync } from 'node:fs';

import { findWorktreeKeep, removeWorktreeKeep, upsertWorktreeKeep } from '@on-par/factory-core/internal';

import { CliExitError } from './index.js';

export interface WorktreeKeepDeps {
  keepsFile: string;
  /** The issue's lane worktree path (worktreePathFor). */
  worktreePath: (issue: number) => string | Promise<string>;
  pathExists?: (p: string) => boolean;
  now?: () => Date;
  out?: (line: string) => void;
  withLock?: <T>(fn: () => Promise<T>) => Promise<T>;
}

const direct = <T>(fn: () => Promise<T>): Promise<T> => fn();

/** Writes a keep record for the issue's lane worktree so GC and the park-time reap leave it alone. */
export async function runWorktreeKeep(issue: number, opts: { reason?: string }, deps: WorktreeKeepDeps): Promise<void> {
  const { pathExists = existsSync, now = () => new Date(), out = console.log, withLock = direct } = deps;
  const reason = opts.reason ?? 'manual';
  if (reason.trim() === '') throw new CliExitError('factory worktree keep: --reason must not be empty', 2);
  const path = await deps.worktreePath(issue);
  if (!pathExists(path)) {
    throw new CliExitError(`factory worktree keep: #${issue} has no lane worktree (looked for ${path})`, 2);
  }
  await withLock(async () =>
    upsertWorktreeKeep(deps.keepsFile, { issue, path, reason: reason.trim(), since: now().toISOString() }),
  );
  out(
    `kept ${path} for #${issue} (${reason.trim()}) — worktree gc leaves it until the issue closes or 'factory worktree release ${issue}'`,
  );
}

/** Drops the issue's keep record; true when one existed. Never creates the keeps file. */
export async function runWorktreeRelease(
  issue: number,
  deps: Pick<WorktreeKeepDeps, 'keepsFile' | 'out' | 'withLock'>,
): Promise<boolean> {
  const { out = console.log, withLock = direct } = deps;
  const had = await withLock(async () => {
    const found = findWorktreeKeep(deps.keepsFile, issue);
    if (found) removeWorktreeKeep(deps.keepsFile, issue);
    return found;
  });
  if (had) {
    out(`released the keep record for #${issue} (${had.reason}) — the next worktree gc treats ${had.path} normally`);
  } else {
    out(`#${issue} had no keep record — nothing to release`);
  }
  return had !== undefined;
}

/** Best-effort: the factory owns the worktree again once the lane re-queues the issue. Never throws. */
export function releaseKeepOnRequeue(keepsFile: string | undefined, issue: number, warn?: (msg: string) => void): void {
  if (keepsFile === undefined) return;
  try {
    removeWorktreeKeep(keepsFile, issue);
  } catch (err) {
    warn?.(`could not drop the keep record for #${issue}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
