// scripts/test-budget.ts — Compare the verify test-step duration against the stored budget.
//
// See #2770. The budget lives here, in TEST_BUDGET_SECONDS. verify.sh times its test step and
// runs this right after slowest-tests. Over budget only warns; it never fails verify.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { formatSlowestFiles, parseFileDurations, slowestFiles, type FileDuration } from './slowest-tests.js';

/**
 * The stored time budget for verify's test step, in seconds (#2770).
 * Measured at ~354s for the serial run (FACTORY_TEST_MAX_WORKERS=1) when the budget was added;
 * 450s gives ~25% headroom. Raise it deliberately when the suite grows; do not tighten it
 * below current runtime plus headroom.
 */
export const TEST_BUDGET_SECONDS = 450;
/** One-run override for the budget, e.g. FACTORY_TEST_BUDGET_SECONDS=1 to exercise the warning. */
export const TEST_BUDGET_ENV = 'FACTORY_TEST_BUDGET_SECONDS';
const DEFAULT_REPORT_PATH = '.tmp/vitest-report.json';

export interface TestBudgetResult {
  elapsedSeconds: number;
  budgetSeconds: number;
  overBudget: boolean;
}

export interface TestBudgetCliIo {
  readFile?: (path: string) => string;
  log?: (line: string) => void;
  cwd?: string;
  env?: Readonly<Record<string, string | undefined>>;
}

/** The budget for this run: the env override when it is a positive integer, else the stored budget. Never throws. */
export function resolveTestBudgetSeconds(env: Readonly<Record<string, string | undefined>>): {
  budgetSeconds: number;
  note?: string;
} {
  const raw = env[TEST_BUDGET_ENV];
  const value = raw?.trim() ?? '';
  if (value === '') return { budgetSeconds: TEST_BUDGET_SECONDS };
  if (/^\d+$/.test(value) && Number(value) >= 1) return { budgetSeconds: Number(value) };
  return {
    budgetSeconds: TEST_BUDGET_SECONDS,
    note: `test-budget: ignoring ${TEST_BUDGET_ENV}='${raw}' (not a positive integer); using ${TEST_BUDGET_SECONDS}s`,
  };
}

/** Equal to the budget counts as within budget. */
export function evaluateTestBudget(elapsedSeconds: number, budgetSeconds: number): TestBudgetResult {
  return { elapsedSeconds, budgetSeconds, overBudget: elapsedSeconds > budgetSeconds };
}

/** Always returns 0: being over budget only prints a warning. */
export function runTestBudgetCli(argv: readonly string[], io: TestBudgetCliIo = {}): number {
  const readFile = io.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
  const log = io.log ?? ((line: string) => console.log(line));
  const cwd = io.cwd ?? process.cwd();
  const env = io.env ?? process.env;
  const path = argv[1] ?? DEFAULT_REPORT_PATH;

  const { budgetSeconds, note } = resolveTestBudgetSeconds(env);
  if (note) log(note);

  const rawElapsed = argv[0];
  const elapsed = rawElapsed === undefined || rawElapsed.trim() === '' ? Number.NaN : Number(rawElapsed);
  if (!Number.isFinite(elapsed) || elapsed < 0) {
    log(`test-budget: no valid test-step duration ('${rawElapsed ?? ''}'); skipping budget check`);
    return 0;
  }

  const result = evaluateTestBudget(elapsed, budgetSeconds);
  if (!result.overBudget) {
    log(`test-budget: PASS — test step took ${elapsed}s, budget ${budgetSeconds}s (scripts/test-budget.ts)`);
    return 0;
  }
  log(
    `test-budget: WARNING — test step took ${elapsed}s, over the ${budgetSeconds}s budget (scripts/test-budget.ts). Not failing verify.`,
  );
  let durations: FileDuration[] = [];
  try {
    durations = parseFileDurations(JSON.parse(readFile(path)), cwd);
  } catch {
    durations = [];
  }
  if (durations.length === 0) {
    log(`test-budget: no per-file durations in ${path}`);
    return 0;
  }
  log(formatSlowestFiles(slowestFiles(durations)));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = runTestBudgetCli(process.argv.slice(2));
}
