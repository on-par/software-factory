// src/filing/policy.ts — Filing policy shape and cap ledger (#374).
//
// Pure helpers: the policy settings, the per-run/per-day filed-bug ledger, and
// the check that lets the merge path refuse to auto-merge factory-self-fixes.

import type { FailoverReason } from '../types/index.js';

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

export interface FilingLedger {
  day: string; // 'YYYY-MM-DD' the perDay counter applies to (UTC)
  filedToday: number;
  filedThisRun: number;
  occurrences: Record<string, number>; // fingerprint -> number of parks seen (incl. suppressed)
}

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function emptyLedger(now: () => Date): FilingLedger {
  return { day: dayKey(now()), filedToday: 0, filedThisRun: 0, occurrences: {} };
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

export function isAutoMergeBlocked(labels: readonly string[], policy: FilingPolicy): boolean {
  return labels.includes(policy.selfFixLabel);
}
