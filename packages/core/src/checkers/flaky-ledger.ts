import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const FLAKY_ISSUE_THRESHOLD = 3;

export interface FlakyLedgerEntry {
  runs: string[];
  lastSeen: string;
  issue: number | null;
}
export type FlakyLedger = Record<string, FlakyLedgerEntry>;
export interface FlakyThresholdEntry extends FlakyLedgerEntry {
  test: string;
}

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
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(ledger, null, 2)}\n`);
  await rename(tmp, file);
}

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

export async function setFlakyIssue(file: string, test: string, issue: number): Promise<void> {
  const ledger = await readFlakyLedger(file);
  if (!ledger[test]) return;
  ledger[test].issue = issue;
  await writeFlakyLedger(file, ledger);
}
