// packages/core/src/review/routing.ts — pre-SHIP PR classifier decision (#1724): turns the final diff
// into a review floor and says whether the run must be held for a human. Never throws (fail closed).

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BASE_REF_CANDIDATES, defaultDiffRunner, type DiffRunner } from '../checkers/design-smells.js';
import {
  computeReviewFloor,
  parseNumstat,
  type ReviewClass,
  type ReviewFloorFiredRule,
  type ReviewFloorPathChange,
  type ReviewFloorResult,
  type ReviewFloorRuleSet,
} from './floor.js';
import type { PrShadowVerdict } from './classifier.js';
import type { TrustTier } from '../config/repo.js';

export { parseNumstat } from './floor.js';

/** Gate reason for a class-A PR held by the T1 deterministic sample (#1958, ADR-0144). */
export const T1_SAMPLED_REASON = 't1-sampled';

/** Receipt for a class-A PR sent to auto-merge at trust tier T2 (#1960, ADR-0144). */
export const T2_AUTO_RECEIPT = 't2-auto';

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
  /** T1 sample (#1958, ADR-0144); present only at T1 for an otherwise ungated A floor. */
  sample?: { value: number; rate: number; held: boolean };
  /** Configured and effective trust tier (#1960); present when the tier is not T0 or a demotion is set. */
  trustTier?: { configured: TrustTier; effective: TrustTier; demotion?: string };
  /** Present only for an ungated class-A routing at an effective T2 (#1960, ADR-0144). */
  receipt?: typeof T2_AUTO_RECEIPT;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
  opts: {
    fallbackBaseRef?: string;
    parentBaseRef?: string;
    run?: DiffRunner;
    readFile?: (path: string) => string;
  } = {},
): Promise<ReviewFloorPathChange[]> {
  const run = opts.run ?? defaultDiffRunner;
  const readFile = opts.readFile ?? ((p: string) => readFileSync(p, 'utf8'));

  let base: string | null = null;
  if (opts.parentBaseRef !== undefined) {
    const ref = opts.parentBaseRef;
    const check = await run(['git', 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`], worktree);
    if (!check.ok) {
      throw new Error(`review floor base ref override '${ref}' does not resolve — not falling back to origin/main`);
    }
    const mb = await run(['git', 'merge-base', ref, 'HEAD'], worktree);
    base = mb.ok && mb.stdout.trim() !== '' ? mb.stdout.trim() : ref;
  }
  if (base === null) {
    for (const candidate of BASE_REF_CANDIDATES) {
      const check = await run(['git', 'rev-parse', '--verify', '--quiet', `${candidate}^{commit}`], worktree);
      if (!check.ok) continue;
      const mb = await run(['git', 'merge-base', candidate, 'HEAD'], worktree);
      base = mb.ok && mb.stdout.trim() !== '' ? mb.stdout.trim() : candidate;
      break;
    }
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
  parentBaseRef?: string;
  rules: ReviewFloorRuleSet;
  readChanges?: (
    worktree: string,
    fallbackBaseRef?: string,
    parentBaseRef?: string,
  ) => Promise<ReviewFloorPathChange[]>;
}): Promise<ReviewRouting> {
  const readChanges =
    input.readChanges ??
    ((w: string, f?: string, p?: string) => readReviewFloorChanges(w, { fallbackBaseRef: f, parentBaseRef: p }));
  try {
    const result = computeReviewFloor({
      changes: await readChanges(input.worktree, input.fallbackBaseRef, input.parentBaseRef),
      rules: input.rules,
    });
    if (result.floor === 'A') return { floor: 'A', rules: result.rules, gated: false };
    return { floor: result.floor, rules: result.rules, gated: true, reason: classifierGateReason(result) };
  } catch (err) {
    return { floor: null, rules: [], gated: true, reason: 'classifier:error', error: errorMessage(err) };
  }
}

/** Deterministic sample position in [0,1) for one issue: sha256 of `<repo>#<issue>`, first 32 bits (#1958). */
export function t1SampleValue(repo: string, issue: number): number {
  const hex = createHash('sha256').update(`${repo}#${issue}`).digest('hex').slice(0, 8);
  return parseInt(hex, 16) / 2 ** 32;
}

/** The tier and sample rate the T1 sample needs, resolved by the CLI (`resolveTrustTier`, `resolveT1SampleRate`). */
export interface T1SampleConfig {
  trustTier: TrustTier;
  t1SampleRate: number;
}

/** At T1, hold a deterministic sample of otherwise ungated class-A PRs for a human (ADR-0144, #1958).
 *  Escalate-only: any other tier, a floor above A, or an already-gated routing is returned unchanged. */
export function decideT1Sample(
  routing: ReviewRouting,
  config: T1SampleConfig,
  { repo, issue }: { repo: string; issue: number },
): ReviewRouting {
  if (config.trustTier !== 'T1' || routing.gated || routing.floor !== 'A') return routing;
  const value = t1SampleValue(repo, issue);
  const held = value < config.t1SampleRate;
  const sample = { value, rate: config.t1SampleRate, held };
  return held
    ? {
        ...routing,
        gated: true,
        reason: `${T1_SAMPLED_REASON} (sample ${value.toFixed(4)} < rate ${config.t1SampleRate})`,
        sample,
      }
    : { ...routing, sample };
}

/** An active, unacknowledged slip demotion (ADR-0148, #1959); drops the effective tier one rung. */
export interface TrustTierDemotion {
  reason: string;
}

/** T1 sample config plus the demotion that can lower the configured tier (#1960). */
export interface TrustTierConfig extends T1SampleConfig {
  demotion?: TrustTierDemotion;
}

/** The tier the gate acts on: a demotion drops the configured tier one rung; an unknown tier fails closed to T0. */
export function effectiveTrustTier(tier: TrustTier, demotion?: TrustTierDemotion): TrustTier {
  if (tier !== 'T0' && tier !== 'T1' && tier !== 'T2') return 'T0';
  if (!demotion) return tier;
  return tier === 'T2' ? 'T1' : 'T0';
}

/** Apply the trust-tier ladder (ADR-0144, #1960): T1 samples, an eligible class-A PR at T2 gets the
 *  `t2-auto` receipt. Escalate-only: it never ungates a gated routing. */
export function decideTrustTier(
  routing: ReviewRouting,
  config: TrustTierConfig,
  { repo, issue }: { repo: string; issue: number },
): ReviewRouting {
  const effective = effectiveTrustTier(config.trustTier, config.demotion);
  const sampled = decideT1Sample(routing, { trustTier: effective, t1SampleRate: config.t1SampleRate }, { repo, issue });
  const tier =
    config.trustTier !== 'T0' || config.demotion
      ? {
          configured: config.trustTier,
          effective,
          ...(config.demotion ? { demotion: config.demotion.reason } : {}),
        }
      : undefined;
  const eligible = effective === 'T2' && !sampled.gated && sampled.floor === 'A';
  return { ...sampled, ...(tier ? { trustTier: tier } : {}), ...(eligible ? { receipt: T2_AUTO_RECEIPT } : {}) };
}
