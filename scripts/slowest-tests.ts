// scripts/slowest-tests.ts — Print the slowest test files from vitest's JSON report.
//
// See #2769. verify.sh runs this right after the test step. It only reports: it never fails,
// and it does not compare durations against a budget (#2737).

import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** One test file's wall-clock duration, from vitest's JSON reporter (endTime - startTime). */
export interface FileDuration {
  file: string;
  durationMs: number;
}

const SLOWEST_TEST_FILES_COUNT = 5;
const DEFAULT_REPORT_PATH = '.tmp/vitest-report.json';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Repo-relative file durations from a vitest JSON report. Entries without a name and finite times are skipped. */
export function parseFileDurations(report: unknown, rootDir: string): FileDuration[] {
  if (!isRecord(report) || !Array.isArray(report.testResults)) return [];
  const durations: FileDuration[] = [];
  for (const entry of report.testResults as unknown[]) {
    if (!isRecord(entry)) continue;
    const { name, startTime, endTime } = entry;
    if (typeof name !== 'string') continue;
    if (typeof startTime !== 'number' || !Number.isFinite(startTime)) continue;
    if (typeof endTime !== 'number' || !Number.isFinite(endTime)) continue;
    durations.push({
      file: relative(rootDir, name).split('\\').join('/'),
      durationMs: Math.max(0, endTime - startTime),
    });
  }
  return durations;
}

/** The `count` slowest files, slowest first. Ties break by file name ascending. */
export function slowestFiles(
  durations: readonly FileDuration[],
  count: number = SLOWEST_TEST_FILES_COUNT,
): FileDuration[] {
  return [...durations].sort((a, b) => b.durationMs - a.durationMs || a.file.localeCompare(b.file)).slice(0, count);
}

export function formatSlowestFiles(files: readonly FileDuration[]): string {
  const lines = files.map((f) => `  ${(f.durationMs / 1000).toFixed(2).padStart(7)}s  ${f.file}`);
  return [`Slowest ${files.length} test files:`, ...lines].join('\n');
}

export interface SlowestTestsCliIo {
  readFile?: (path: string) => string;
  log?: (line: string) => void;
  cwd?: string;
}

/** Always returns 0: a missing or malformed report only prints a note. */
export function runSlowestTestsCli(argv: readonly string[], io: SlowestTestsCliIo = {}): number {
  const readFile = io.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
  const log = io.log ?? ((line: string) => console.log(line));
  const cwd = io.cwd ?? process.cwd();
  const path = argv[0] ?? DEFAULT_REPORT_PATH;

  let durations: FileDuration[] = [];
  try {
    durations = parseFileDurations(JSON.parse(readFile(path)), cwd);
  } catch {
    durations = [];
  }
  if (durations.length === 0) {
    log(`slowest-tests: no per-file durations in ${path}`);
    return 0;
  }
  log(formatSlowestFiles(slowestFiles(durations)));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = runSlowestTestsCli(process.argv.slice(2));
}
