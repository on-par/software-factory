// src/checkers/flaky-ledger.ts — per-repo ledger of tests that flaked, by distinct run (#2303)
//
// CHECK's serial re-run can pass a base-red tests checker (a flake). This file-backed ledger
// records, per test name, the distinct runs ("<issue>@<baseSha8>") it flaked in, so a test that
// keeps flaking can reach a human once it crosses FLAKY_ISSUE_THRESHOLD runs.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Distinct runs a test must flake in before a flaky-test issue is filed. */
export const FLAKY_ISSUE_THRESHOLD = 3;

export interface FlakyLedgerEntry {
  /** Distinct runs the test flaked in, as "<issue>@<baseSha8>", oldest first. */
  runs: string[];
  /** ISO time of the most recent flake. */
  lastSeen: string;
  /** Flaky-test issue filed for this test, or null until the threshold files one. */
  issue: number | null;
}
export type FlakyLedger = Record<string, FlakyLedgerEntry>;
export interface FlakyThresholdEntry extends FlakyLedgerEntry {
  test: string;
}

/** Reads the ledger; any unreadable or malformed file is an empty ledger, bad entries are dropped. */
export async function readFlakyLedger(file: string): Promise<FlakyLedger> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, 'utf-8'));
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
  const ledger: FlakyLedger = {};
  for (const [test, raw] of Object.entries(parsed)) {
    if (typeof raw !== 'object' || raw === null) continue;
    const { runs, lastSeen, issue = null } = raw as Record<string, unknown>;
    if (!Array.isArray(runs) || !runs.every((r) => typeof r === 'string')) continue;
    if (typeof lastSeen !== 'string') continue;
    if (issue !== null && typeof issue !== 'number') continue;
    ledger[test] = { runs: runs as string[], lastSeen, issue };
  }
  return ledger;
}

async function writeFlakyLedger(file: string, ledger: FlakyLedger): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  // Unique tmp name: lanes run concurrently. A lost concurrent write only delays the threshold.
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(ledger, null, 2)}\n`);
  await rename(tmp, file);
}

/** Records the run against each test; returns the touched entries at or over the threshold. */
export async function recordFlakes(
  file: string,
  run: string,
  tests: readonly string[],
  now: () => Date = () => new Date(),
): Promise<FlakyThresholdEntry[]> {
  const unique = [...new Set(tests)];
  if (unique.length === 0) return [];
  const ledger = await readFlakyLedger(file);
  const lastSeen = now().toISOString();
  for (const test of unique) {
    const entry = (ledger[test] ??= { runs: [], lastSeen, issue: null });
    if (!entry.runs.includes(run)) entry.runs.push(run);
    entry.lastSeen = lastSeen;
  }
  await writeFlakyLedger(file, ledger);
  return unique
    .filter((test) => ledger[test].runs.length >= FLAKY_ISSUE_THRESHOLD)
    .map((test) => ({ test, ...ledger[test] }));
}

/** Stores the filed flaky-test issue number; an unknown test is a no-op. */
export async function setFlakyIssue(file: string, test: string, issue: number): Promise<void> {
  const ledger = await readFlakyLedger(file);
  if (!ledger[test]) return;
  ledger[test].issue = issue;
  await writeFlakyLedger(file, ledger);
}
