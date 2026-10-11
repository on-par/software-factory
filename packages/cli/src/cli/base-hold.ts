// packages/cli/src/cli/base-hold.ts — base hold persisted when a lane pauses on a broken
// base SHA (#2348), so a restarted supervisor remembers the pause.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** A base SHA found broken by an environment pause (ADR-0141). */
export interface BaseHold {
  /** `owner/name` of the repo the hold applies to. */
  repo: string;
  baseSha: string;
  failingChecks: string[];
  /** ISO-8601 time the hold was recorded. */
  since: string;
}

export function writeBaseHold(file: string, hold: BaseHold): void {
  mkdirSync(dirname(file), { recursive: true });
  const record: BaseHold = {
    repo: hold.repo,
    baseSha: hold.baseSha,
    failingChecks: [...hold.failingChecks],
    since: hold.since,
  };
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
}

/** Fails soft: a missing, unreadable, non-JSON, non-object or wrongly-typed file is no hold (null). */
export function readBaseHold(file: string): BaseHold | null {
  if (!existsSync(file)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const { repo, baseSha, failingChecks, since } = raw as Record<string, unknown>;
  if (typeof repo !== 'string' || typeof baseSha !== 'string' || typeof since !== 'string') return null;
  if (!Array.isArray(failingChecks) || !failingChecks.every((c) => typeof c === 'string')) return null;
  return { repo, baseSha, failingChecks: [...failingChecks], since };
}

export function deleteBaseHold(file: string): void {
  rmSync(file, { force: true });
}
