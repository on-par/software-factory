// packages/cli/src/cli/base-hold.ts — base hold persisted when a lane pauses on a broken
// base SHA (#2348), so a restarted supervisor remembers the pause. #2349 reads it back as the
// claim gate: no claiming while origin/main is still at the held SHA and its CI is not green.
// #2350 clears the hold once origin/main moves or its CI goes green. #2351 reads it for
// `factory status`. #3186 adds `ciRecheckAfter`: a hold awaiting GitHub CI on a timed-out base
// compile backs off and is re-checked with the strict required-checks verdict, not the lenient one.
// #3287 adds `confirmedLocally`: a hold whose fresh local re-run failed while CI was green is
// never cleared by CI green, only when origin/main moves.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { RequiredChecksVerdict } from '@on-par/factory-core/internal';

/** A base SHA found broken by an environment pause (ADR-0141). */
export interface BaseHold {
  /** `owner/name` of the repo the hold applies to. */
  repo: string;
  baseSha: string;
  failingChecks: string[];
  /** ISO-8601 time the hold was recorded. */
  since: string;
  /** ISO-8601 time; set when the hold awaits GitHub CI on a timed-out base compile (#3186). */
  ciRecheckAfter?: string;
  /** A fresh local re-run failed while CI was green (#3287); CI green never clears it. */
  confirmedLocally?: true;
}

/** Backoff between strict CI re-checks of a ci-awaiting hold (#3186). */
export const BASE_HOLD_CI_RECHECK_MS = 5 * 60 * 1000;

export function writeBaseHold(file: string, hold: BaseHold): void {
  mkdirSync(dirname(file), { recursive: true });
  const record: BaseHold = {
    repo: hold.repo,
    baseSha: hold.baseSha,
    failingChecks: [...hold.failingChecks],
    since: hold.since,
    ...(hold.ciRecheckAfter !== undefined ? { ciRecheckAfter: hold.ciRecheckAfter } : {}),
    ...(hold.confirmedLocally === true ? { confirmedLocally: true as const } : {}),
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
  const { repo, baseSha, failingChecks, since, ciRecheckAfter, confirmedLocally } = raw as Record<string, unknown>;
  if (typeof repo !== 'string' || typeof baseSha !== 'string' || typeof since !== 'string') return null;
  if (!Array.isArray(failingChecks) || !failingChecks.every((c) => typeof c === 'string')) return null;
  const recheck =
    typeof ciRecheckAfter === 'string' && Number.isFinite(Date.parse(ciRecheckAfter)) ? { ciRecheckAfter } : {};
  return {
    repo,
    baseSha,
    failingChecks: [...failingChecks],
    since,
    ...recheck,
    ...(confirmedLocally === true ? { confirmedLocally: true as const } : {}),
  };
}

export function deleteBaseHold(file: string): void {
  rmSync(file, { force: true });
}

/** Why a hold ended (#2350). */
export type BaseHoldClearReason = 'sha-changed' | 'ci-green';

export interface BaseHoldCleared {
  hold: BaseHold;
  reason: BaseHoldClearReason;
  /** origin/main SHA seen on the clearing poll. */
  currentSha: string;
  /** What a ci-green verdict was based on (#3195). */
  basis?: string;
}

/** Deletes the hold only if it is still on `baseSha`; true only when this call deleted it. Fully
 *  synchronous, so concurrent lanes in one process cannot both get true. */
export function clearBaseHold(file: string, baseSha: string): boolean {
  const current = readBaseHold(file);
  if (current === null || current.baseSha !== baseSha) return false;
  deleteBaseHold(file);
  return true;
}

export function formatBaseHoldCleared(c: BaseHoldCleared): string {
  const held = c.hold.baseSha.slice(0, 8);
  const now = c.currentSha.slice(0, 8);
  return c.reason === 'sha-changed'
    ? `base hold on ${held} cleared (reason: sha-changed): origin/main moved to ${now}`
    : `base hold on ${held} cleared (reason: ci-green): main CI on ${now} is green (${c.basis ?? 'required checks'})`;
}

/** `factory status` lines for an active hold (#2351). */
export function formatBaseHoldStatus(hold: BaseHold): string[] {
  const checks = hold.failingChecks.length > 0 ? hold.failingChecks.join(', ') : '(none recorded)';
  const lines = [
    `  repo: ${hold.repo}`,
    `  baseSha: ${hold.baseSha}`,
    `  failingChecks: ${checks}`,
    `  since: ${hold.since}`,
  ];
  if (hold.confirmedLocally === true) lines.push('  confirmedLocally: true');
  return lines;
}

export type BaseHoldDecision = { kind: 'claim' } | { kind: 'hold'; hold: BaseHold; ciReason?: string };

export interface BaseHoldGateDeps {
  /** Current origin/main SHA; null (or a throw) means unknown. */
  currentBaseSha: () => Promise<string | null>;
  /** Strict CI verdict used for every hold (#3186, #3195); absent = not green. */
  requiredChecksVerdict?: (sha: string) => Promise<RequiredChecksVerdict>;
  /** Clock in epoch ms; defaults to Date.now. */
  now?: () => number;
  /** Called once, only by the poll that actually deleted the hold. A throw is swallowed. */
  onCleared?: (cleared: BaseHoldCleared) => void;
}

/** Decides whether a lane may claim: hold only while origin/main is still at the held SHA and
 *  its CI is not green. Unknown origin/main fails open; a failed CI lookup counts as not green.
 *  Clears the hold when origin/main moved or its CI is green (#2350). */
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
  const clear = (reason: BaseHoldClearReason, currentSha: string, basis?: string): void => {
    if (!clearBaseHold(file, hold.baseSha)) return;
    try {
      deps.onCleared?.({ hold, reason, currentSha, ...(basis !== undefined ? { basis } : {}) });
    } catch {
      // an observer failure must not change the decision
    }
  };
  if (sha !== hold.baseSha) {
    clear('sha-changed', sha);
    return { kind: 'claim' };
  }
  if (hold.confirmedLocally === true) {
    return { kind: 'hold', hold, ciReason: 'confirmed locally: a fresh base re-run failed while CI was green' };
  }
  if (hold.ciRecheckAfter !== undefined) {
    const now = deps.now ?? Date.now;
    if (now() < Date.parse(hold.ciRecheckAfter)) return { kind: 'hold', hold };
    const v = await strictVerdict(deps, sha);
    if (v.green) {
      clear('ci-green', sha, v.basis);
      return { kind: 'claim' };
    }
    try {
      writeBaseHold(file, { ...hold, ciRecheckAfter: new Date(now() + BASE_HOLD_CI_RECHECK_MS).toISOString() });
    } catch {
      // a failed re-arm only means the next poll re-checks sooner
    }
    return { kind: 'hold', hold, ciReason: v.reason };
  }
  const v = await strictVerdict(deps, sha);
  if (!v.green) return { kind: 'hold', hold, ciReason: v.reason };
  clear('ci-green', sha, v.basis);
  return { kind: 'claim' };
}

async function strictVerdict(deps: BaseHoldGateDeps, sha: string): Promise<RequiredChecksVerdict> {
  if (!deps.requiredChecksVerdict) return { green: false, reason: 'no CI lookup configured' };
  try {
    const v = await deps.requiredChecksVerdict(sha);
    return v.green ? v : { ...v, green: false };
  } catch (err) {
    return { green: false, reason: `CI lookup failed: ${err instanceof Error ? err.message : String(err)}` };
  }
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
  requiredChecksVerdict?: (sha: string) => Promise<RequiredChecksVerdict>;
  onCleared?: (cleared: BaseHoldCleared) => void;
  now?: () => number;
}): () => Promise<BaseHoldDecision> {
  return () =>
    evaluateBaseHold(opts.file, opts.repo, {
      currentBaseSha: async () => parseLsRemoteSha(await opts.git('git ls-remote origin refs/heads/main')),
      requiredChecksVerdict: opts.requiredChecksVerdict,
      onCleared: opts.onCleared,
      now: opts.now,
    });
}
