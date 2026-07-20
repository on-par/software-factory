// src/filing/policy.ts — Decide *when* to file a fingerprinted bug (#374).
//
// Pure policy: suppresses filing for expected/throttle conditions unless the
// same fingerprint keeps recurring, enforces per-run/per-day ceilings, and
// labels factory-self-fixes so the merge path can refuse to auto-merge them.

import type { EvidencePack, FailoverReason, FingerprintedFailure } from '../types/index.js';

export interface FilingPolicy {
  enabled: boolean;
  excludeReasons: readonly FailoverReason[]; // expected/throttle conditions
  repeatThreshold: number; // same-fingerprint park count that overrides exclusion
  maxPerRun: number; // ceiling on new bugs filed this process/run
  maxPerDay: number; // ceiling on new bugs filed per calendar day (UTC)
  selfFixLabel: string; // label applied to factory-self-fix bugs, e.g. 'no-auto-merge'
  bugLabels: readonly string[]; // base labels, default ['bug']
  sensitivePaths: readonly string[]; // path prefixes whose fix is human-gated
}

export const DEFAULT_FILING_POLICY: FilingPolicy = {
  enabled: true,
  excludeReasons: ['rate_limit', 'usage_cap', 'timeout', 'verify_failed'],
  repeatThreshold: 3,
  maxPerRun: 5,
  maxPerDay: 20,
  selfFixLabel: 'no-auto-merge',
  bugLabels: ['bug'],
  sensitivePaths: ['packages/core/', 'packages/config/', 'packages/cli/', 'scripts/', '.github/'],
};

export interface FilingLedger {
  day: string; // 'YYYY-MM-DD' the perDay counter applies to (UTC)
  filedToday: number;
  filedThisRun: number;
  occurrences: Record<string, number>; // fingerprint -> number of parks seen (incl. suppressed)
}

export type FilingSkipReason = 'filing-disabled' | 'expected-condition' | 'per-run-cap' | 'per-day-cap';

export type FilingDecision =
  | { file: true; fingerprint: string; occurrences: number; labels: string[] }
  | { file: false; fingerprint: string; skipReason: FilingSkipReason; occurrences: number };

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function emptyLedger(now: () => Date): FilingLedger {
  return { day: dayKey(now()), filedToday: 0, filedThisRun: 0, occurrences: {} };
}

export function recordPark(ledger: FilingLedger, fingerprint: string): FilingLedger {
  return {
    ...ledger,
    occurrences: { ...ledger.occurrences, [fingerprint]: (ledger.occurrences[fingerprint] ?? 0) + 1 },
  };
}

export function rollDay(ledger: FilingLedger, now: () => Date): FilingLedger {
  const today = dayKey(now());
  if (today === ledger.day) return { ...ledger };
  return { ...ledger, day: today, filedToday: 0 };
}

export function recordFiled(ledger: FilingLedger, now: () => Date): FilingLedger {
  const rolled = rollDay(ledger, now);
  return { ...rolled, filedToday: rolled.filedToday + 1, filedThisRun: rolled.filedThisRun + 1 };
}

export function evaluateFilingPolicy(
  fingerprinted: FingerprintedFailure,
  ledger: FilingLedger,
  policy: FilingPolicy,
  now: () => Date,
): FilingDecision {
  const { evidence, fingerprint: fp } = fingerprinted;
  const occ = (ledger.occurrences[fp] ?? 0) + 1;

  if (!policy.enabled) {
    return { file: false, fingerprint: fp, skipReason: 'filing-disabled', occurrences: occ };
  }

  const repeatOverride = occ >= policy.repeatThreshold;
  if (policy.excludeReasons.includes(evidence.reason) && !repeatOverride) {
    return { file: false, fingerprint: fp, skipReason: 'expected-condition', occurrences: occ };
  }

  const rolled = rollDay(ledger, now);
  if (rolled.filedToday >= policy.maxPerDay) {
    return { file: false, fingerprint: fp, skipReason: 'per-day-cap', occurrences: occ };
  }
  if (rolled.filedThisRun >= policy.maxPerRun) {
    return { file: false, fingerprint: fp, skipReason: 'per-run-cap', occurrences: occ };
  }

  return { file: true, fingerprint: fp, occurrences: occ, labels: labelsFor(evidence, policy) };
}

export function labelsFor(evidence: EvidencePack, policy: FilingPolicy): string[] {
  const labels = [...policy.bugLabels];
  if (evidence.origin === 'factory-internal') labels.push(policy.selfFixLabel);
  return [...new Set(labels)];
}

export function touchesSensitiveScope(changedPaths: readonly string[], policy: FilingPolicy): boolean {
  const sensitiveRe = /(security|auth|credential|token|secret|merge|land)/i;
  return changedPaths.some(
    (path) => policy.sensitivePaths.some((prefix) => path.startsWith(prefix)) || sensitiveRe.test(path),
  );
}

export function isAutoMergeBlocked(labels: readonly string[], policy: FilingPolicy): boolean {
  return labels.includes(policy.selfFixLabel);
}
