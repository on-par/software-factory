// packages/core/src/worktree/worktree-keeps.ts — persistent keep records that protect a parked issue's worktree from GC (#3316)

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { EventKind } from '../events/kinds.js';

export interface WorktreeKeep {
  issue: number;
  path: string;
  reason: string;
  since: string;
}

type KeepLog = (type: EventKind, msg: string) => void;

function isKeep(value: unknown): value is WorktreeKeep {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    Number.isInteger(v.issue) &&
    typeof v.path === 'string' &&
    typeof v.reason === 'string' &&
    typeof v.since === 'string'
  );
}

/** Reads the keep store. A missing file is empty with no log; an unreadable or malformed one is
 *  empty with one warn. Invalid individual entries are dropped. */
export function readWorktreeKeeps(file: string, log?: KeepLog): WorktreeKeep[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (!Array.isArray(parsed)) throw new Error('not an array');
  } catch (err: any) {
    if (err?.code === 'ENOENT') return [];
    log?.('warn', `worktree-gc: cannot read ${file} (${err?.message ?? String(err)}) — treating as no kept worktrees`);
    return [];
  }
  return (parsed as unknown[]).filter(isKeep);
}

export function findWorktreeKeep(file: string, issue: number, log?: KeepLog): WorktreeKeep | undefined {
  return readWorktreeKeeps(file, log).find((k) => k.issue === issue);
}

function writeKeeps(file: string, keeps: WorktreeKeep[]): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(keeps, null, 2)}\n`);
  renameSync(tmp, file);
}

/** Replaces the record for `keep.issue`, else appends. */
export function upsertWorktreeKeep(file: string, keep: WorktreeKeep): void {
  const others = readWorktreeKeeps(file).filter((k) => k.issue !== keep.issue);
  writeKeeps(file, [...others, keep]);
}

/** Drops the record for `issue`. A no-op (and never creates the file) when absent. */
export function removeWorktreeKeep(file: string, issue: number): void {
  const all = readWorktreeKeeps(file);
  const rest = all.filter((k) => k.issue !== issue);
  if (rest.length === all.length) return;
  writeKeeps(file, rest);
}

/** Drops the records of kept worktrees a sweep just removed (path -> issue), once the path is gone. */
export function releaseWorktreeKeeps(file: string, released: ReadonlyMap<string, number>, log: KeepLog): void {
  for (const [path, issue] of released) {
    if (existsSync(path)) continue;
    try {
      removeWorktreeKeep(file, issue);
    } catch (err: any) {
      log('warn', `could not drop the keep record for #${issue}: ${err?.message ?? String(err)}`);
    }
  }
}
