// packages/core/src/review/routing.ts — pre-SHIP PR classifier decision (#1724): turns the final diff
// into a review floor and says whether the run must be held for a human. Never throws (fail closed).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BASE_REF_CANDIDATES, defaultDiffRunner, type DiffRunner } from '../checkers/design-smells.js';
import {
  computeReviewFloor,
  type ReviewClass,
  type ReviewFloorFiredRule,
  type ReviewFloorPathChange,
  type ReviewFloorResult,
  type ReviewFloorRuleSet,
} from './floor.js';
import type { PrShadowVerdict } from './classifier.js';

/** The classifier's pre-SHIP decision for one run (#1724). */
export interface ReviewRouting {
  /** null when the floor could not be computed (error ⇒ gated). */
  floor: ReviewClass | null;
  rules: ReviewFloorFiredRule[];
  gated: boolean;
  /** `classifier:floor:<class>:<ids>` or `classifier:error`; absent when not gated. */
  reason?: string;
  /** Error message when the floor threw. */
  error?: string;
  /** Shadow model verdict (#1725, ADR-0121) — recorded only; never affects `gated`. */
  shadow?: PrShadowVerdict;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Parse `git diff --numstat` output. A binary file's `-` counts become NaN, which
 *  computeReviewFloor treats as invalid input ⇒ class C (fail closed). */
export function parseNumstat(stdout: string): ReviewFloorPathChange[] {
  const changes: ReviewFloorPathChange[] = [];
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue;
    const [added = '', removed = '', ...rest] = line.split('\t');
    changes.push({ path: rest.join('\t'), added: Number(added), removed: Number(removed) });
  }
  return changes;
}

function countLines(text: string): number {
  if (text === '') return 0;
  const n = text.split('\n').length;
  return text.endsWith('\n') ? n - 1 : n;
}

/** All changes in the PR: the working tree against the merge-base with the remote base ref
 *  (the same base CHECK resolves), plus untracked files. Throws when no base can be found. */
export async function readReviewFloorChanges(
  worktree: string,
  opts: { fallbackBaseRef?: string; run?: DiffRunner; readFile?: (path: string) => string } = {},
): Promise<ReviewFloorPathChange[]> {
  const run = opts.run ?? defaultDiffRunner;
  const readFile = opts.readFile ?? ((p: string) => readFileSync(p, 'utf8'));

  let base: string | null = null;
  for (const candidate of BASE_REF_CANDIDATES) {
    const check = await run(['git', 'rev-parse', '--verify', '--quiet', `${candidate}^{commit}`], worktree);
    if (!check.ok) continue;
    const mb = await run(['git', 'merge-base', candidate, 'HEAD'], worktree);
    base = mb.ok && mb.stdout.trim() !== '' ? mb.stdout.trim() : candidate;
    break;
  }
  if (base === null && opts.fallbackBaseRef !== undefined) {
    const check = await run(['git', 'rev-parse', '--verify', '--quiet', `${opts.fallbackBaseRef}^{commit}`], worktree);
    if (check.ok) base = opts.fallbackBaseRef;
  }
  if (base === null) {
    throw new Error('no base ref for review floor (tried origin/main, origin/master, build diff base)');
  }

  const numstat = await run(['git', 'diff', '--numstat', '--no-renames', base], worktree);
  if (!numstat.ok) throw new Error(`git diff --numstat against ${base} failed`);
  const changes = parseNumstat(numstat.stdout);

  const untracked = await run(['git', 'ls-files', '--others', '--exclude-standard'], worktree);
  if (!untracked.ok) throw new Error('git ls-files --others failed');
  for (const path of untracked.stdout.split('\n').filter((p) => p.trim() !== '')) {
    changes.push({ path, added: countLines(readFile(join(worktree, path))), removed: 0 });
  }
  return changes;
}

export function classifierGateReason(result: ReviewFloorResult): string {
  return `classifier:floor:${result.floor}:${result.rules.map((r) => r.id).join(',')}`;
}

/** Compute the routing decision. Never throws: any failure yields a gated `classifier:error`. */
export async function resolveReviewRouting(input: {
  worktree: string;
  fallbackBaseRef?: string;
  rules: ReviewFloorRuleSet;
  readChanges?: (worktree: string, fallbackBaseRef?: string) => Promise<ReviewFloorPathChange[]>;
}): Promise<ReviewRouting> {
  const readChanges =
    input.readChanges ?? ((w: string, f?: string) => readReviewFloorChanges(w, { fallbackBaseRef: f }));
  try {
    const result = computeReviewFloor({
      changes: await readChanges(input.worktree, input.fallbackBaseRef),
      rules: input.rules,
    });
    if (result.floor === 'A') return { floor: 'A', rules: result.rules, gated: false };
    return { floor: result.floor, rules: result.rules, gated: true, reason: classifierGateReason(result) };
  } catch (err) {
    return { floor: null, rules: [], gated: true, reason: 'classifier:error', error: errorMessage(err) };
  }
}
