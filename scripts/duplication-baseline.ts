import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_REPORT_PATH = '.tmp/jscpd/jscpd-report.json';
const DEFAULT_BASELINE_PATH = 'duplication-baseline.json';
const TOP_GROUPS = 10;

export interface DuplicationBaseline {
  clones: number;
  percentage: number;
}

export interface CloneGroup {
  lines: number;
  tokens: number;
  first: string;
  second: string;
}

export type DuplicationVerdict = 'rose' | 'dropped' | 'equal';

export interface DuplicationCliIo {
  readFile?: (path: string) => string;
  log?: (line: string) => void;
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${what} is not an object`);
  }
  return Object.fromEntries(Object.entries(value));
}

function asNumber(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${what} is missing or not a number`);
  return value;
}

function asString(value: unknown, what: string): string {
  if (typeof value !== 'string') throw new Error(`${what} is missing or not a string`);
  return value;
}

function parseLocation(value: unknown, what: string): string {
  const file = asRecord(value, what);
  return `${asString(file.name, `${what}.name`)}:${asNumber(file.start, `${what}.start`)}-${asNumber(file.end, `${what}.end`)}`;
}

function parseTotals(value: unknown, what: string): DuplicationBaseline {
  const record = asRecord(value, what);
  return {
    clones: asNumber(record.clones, `${what}.clones`),
    percentage: asNumber(record.percentage, `${what}.percentage`),
  };
}

export function parseJscpdReport(raw: unknown): { totals: DuplicationBaseline; groups: CloneGroup[] } {
  const report = asRecord(raw, 'report');
  const statistics = asRecord(report.statistics, 'report.statistics');
  const totals = parseTotals(statistics.total, 'report.statistics.total');
  const duplicates = Array.isArray(report.duplicates) ? report.duplicates : [];
  const groups = duplicates.map((entry: unknown): CloneGroup => {
    const duplicate = asRecord(entry, 'duplicate');
    return {
      lines: asNumber(duplicate.lines, 'duplicate.lines'),
      tokens: asNumber(duplicate.tokens, 'duplicate.tokens'),
      first: parseLocation(duplicate.firstFile, 'duplicate.firstFile'),
      second: parseLocation(duplicate.secondFile, 'duplicate.secondFile'),
    };
  });
  return { totals, groups };
}

function roundPercentage(value: number): number {
  return Math.round(value * 100) / 100;
}

export function compareToBaseline(measured: DuplicationBaseline, baseline: DuplicationBaseline): DuplicationVerdict {
  if (measured.clones > baseline.clones) return 'rose';
  if (measured.clones < baseline.clones) return 'dropped';
  return 'equal';
}

export function largestCloneGroups(groups: readonly CloneGroup[], limit = TOP_GROUPS): CloneGroup[] {
  return [...groups]
    .sort((a, b) => b.lines - a.lines || b.tokens - a.tokens || a.first.localeCompare(b.first))
    .slice(0, limit);
}

export function runDuplicationBaselineCli(argv: readonly string[], io: DuplicationCliIo = {}): number {
  const readFile = io.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
  const log = io.log ?? ((line: string) => console.log(line));
  const reportPath = argv[0] ?? DEFAULT_REPORT_PATH;
  const baselinePath = argv[1] ?? DEFAULT_BASELINE_PATH;

  let parsed: ReturnType<typeof parseJscpdReport>;
  try {
    parsed = parseJscpdReport(JSON.parse(readFile(reportPath)));
  } catch (error) {
    log(
      `duplication: FAIL — cannot read report ${reportPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
  let baseline: DuplicationBaseline;
  try {
    baseline = parseTotals(JSON.parse(readFile(baselinePath)), baselinePath);
  } catch (error) {
    log(
      `duplication: FAIL — cannot read baseline ${baselinePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }

  const { totals, groups } = parsed;
  log(
    `duplication: measured ${totals.clones} clones, ${totals.percentage}% (baseline ${baseline.clones}, ${baseline.percentage}%)`,
  );
  log(`Top ${TOP_GROUPS} clone groups:`);
  largestCloneGroups(groups).forEach((group, index) => {
    log(`${index + 1}. ${group.lines} lines, ${group.tokens} tokens: ${group.first} <-> ${group.second}`);
  });

  const verdict = compareToBaseline(totals, baseline);
  if (verdict === 'rose') {
    log(`duplication: FAIL — clones rose above ${DEFAULT_BASELINE_PATH}`);
    return 1;
  }
  if (verdict === 'dropped') {
    log(
      `duplication: PASS — clones dropped; you may lower ${DEFAULT_BASELINE_PATH} to {"clones": ${totals.clones}, "percentage": ${roundPercentage(totals.percentage)}}`,
    );
    return 0;
  }
  log('duplication: PASS');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = runDuplicationBaselineCli(process.argv.slice(2));
}
