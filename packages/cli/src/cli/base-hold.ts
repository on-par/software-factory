// packages/cli/src/cli/base-hold.ts — base hold persisted when a lane pauses on a broken
// base SHA (#2348), so a restarted supervisor remembers the pause. #2349 reads it back as the
// claim gate: no claiming while origin/main is still at the held SHA and its CI is not green.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { isPassingConclusion } from '@on-par/factory-core/internal';

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

export type BaseHoldDecision = { kind: 'claim' } | { kind: 'hold'; hold: BaseHold };

export interface BaseHoldGateDeps {
  /** Current origin/main SHA; null (or a throw) means unknown. */
  currentBaseSha: () => Promise<string | null>;
  /** True only when main's CI on `sha` is green. */
  baseCiGreen: (sha: string) => Promise<boolean>;
}

/** Decides whether a lane may claim: hold only while origin/main is still at the held SHA and
 *  its CI is not green. Unknown origin/main fails open; a failed CI lookup counts as not green.
 *  Never deletes the hold file. */
export async function evaluateBaseHold(file: string, repo: string, deps: BaseHoldGateDeps): Promise<BaseHoldDecision> {
  const hold = readBaseHold(file);
  if (hold === null || hold.repo !== repo) return { kind: 'claim' };
  let sha: string | null;
  try {
    sha = await deps.currentBaseSha();
  } catch {
    sha = null;
  }
  if (sha === null) return { kind: 'claim' };
  if (sha !== hold.baseSha) return { kind: 'claim' };
  let green = false;
  try {
    green = await deps.baseCiGreen(sha);
  } catch {
    green = false;
  }
  return green ? { kind: 'claim' } : { kind: 'hold', hold };
}

/** Green = at least one check run, all completed, all on the ADR-0014 passing allow-list. */
export function isGreenCheckRunSet(runs: ReadonlyArray<{ status: string | null; conclusion: string | null }>): boolean {
  return runs.length > 0 && runs.every((r) => r.status === 'completed' && isPassingConclusion(r.conclusion));
}

/** SHA from the first line of `git ls-remote` output, or null when absent or malformed. */
export function parseLsRemoteSha(stdout: string): string | null {
  const line = stdout.split('\n').find((l) => l.trim() !== '');
  const field = line?.trim().split(/\s+/)[0] ?? '';
  return /^[0-9a-f]{40}$/i.test(field) ? field : null;
}

export function createBaseHoldGate(opts: {
  file: string;
  repo: string;
  git: (cmd: string) => Promise<string>;
  listCheckRuns: (ref: string) => Promise<Array<{ status: string | null; conclusion: string | null }>>;
}): () => Promise<BaseHoldDecision> {
  return () =>
    evaluateBaseHold(opts.file, opts.repo, {
      currentBaseSha: async () => parseLsRemoteSha(await opts.git('git ls-remote origin refs/heads/main')),
      baseCiGreen: async (sha) => isGreenCheckRunSet(await opts.listCheckRuns(sha)),
    });
}
