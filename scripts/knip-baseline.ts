import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_BASELINE_PATH = 'knip-baseline.json';
const MAX_BUFFER = 64 * 1024 * 1024;
const MODES: readonly KnipMode[] = ['default', 'production'];
const MODE_ARGS: Record<KnipMode, readonly string[]> = {
  default: ['--reporter', 'json', '--no-exit-code'],
  production: ['--production', '--reporter', 'json', '--no-exit-code'],
};
const HELP =
  'usage: tsx scripts/knip-baseline.ts [baseline-path] [--write]\n--write regenerates the baseline from knip; it must only shrink the file.';

export type KnipMode = 'default' | 'production';

export interface KnipBaseline {
  default: string[];
  production: string[];
}

export type KnipVerdict = { kind: 'pass' } | { kind: 'changed'; added: string[]; removed: string[] };

export interface KnipCliIo {
  runKnip?: (args: readonly string[]) => string;
  readFile?: (path: string) => string;
  writeFile?: (path: string, content: string) => void;
  log?: (line: string) => void;
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${what} is not an object`);
  }
  return Object.fromEntries(Object.entries(value));
}

function asString(value: unknown, what: string): string {
  if (typeof value !== 'string') throw new Error(`${what} is missing or not a string`);
  return value;
}

function itemName(item: unknown): string {
  if (typeof item === 'string') return item;
  return asString(asRecord(item, 'issue item').name, 'issue item.name');
}

function collectNames(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(itemName);
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(collectNames);
  return [];
}

export function parseKnipReport(raw: unknown, mode: KnipMode): string[] {
  const report = asRecord(raw, 'knip report');
  if (!Array.isArray(report.issues)) throw new Error('knip report.issues is missing or not an array');
  const keys: string[] = [];
  if (Array.isArray(report.files)) {
    for (const file of report.files) keys.push(`${mode}|files|${asString(file, 'files entry')}|`);
  }
  for (const entry of report.issues) {
    const issue = asRecord(entry, 'issue');
    const file = asString(issue.file, 'issue.file');
    for (const [type, value] of Object.entries(issue)) {
      if (type === 'file' || type === 'owners') continue;
      for (const name of collectNames(value)) keys.push(`${mode}|${type}|${file}|${name}`);
    }
  }
  return [...new Set(keys)].sort();
}

export function compareKnipFindings(measured: readonly string[], baseline: readonly string[]): KnipVerdict {
  const measuredSet = new Set(measured);
  const baselineSet = new Set(baseline);
  const added = measured.filter((key) => !baselineSet.has(key)).sort();
  const removed = baseline.filter((key) => !measuredSet.has(key)).sort();
  if (added.length === 0 && removed.length === 0) return { kind: 'pass' };
  return { kind: 'changed', added, removed };
}

function parseBaseline(raw: unknown, what: string): KnipBaseline {
  const record = asRecord(raw, what);
  const read = (mode: KnipMode): string[] => {
    const value = record[mode];
    if (!Array.isArray(value)) throw new Error(`${what}.${mode} is missing or not an array`);
    return value.map((entry) => asString(entry, `${what}.${mode} entry`));
  };
  return { default: read('default'), production: read('production') };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function runKnipBaselineCli(argv: readonly string[], io: KnipCliIo = {}): number {
  const runKnip =
    io.runKnip ??
    ((args: readonly string[]) => execFileSync('npx', ['knip', ...args], { encoding: 'utf8', maxBuffer: MAX_BUFFER }));
  const readFile = io.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
  const writeFile = io.writeFile ?? ((p: string, content: string) => writeFileSync(p, content));
  const log = io.log ?? ((line: string) => console.log(line));
  if (argv.includes('--help')) {
    log(HELP);
    return 0;
  }
  const write = argv.includes('--write');
  const baselinePath = argv.find((arg) => !arg.startsWith('--')) ?? DEFAULT_BASELINE_PATH;

  const measured: Partial<KnipBaseline> = {};
  for (const mode of MODES) {
    try {
      measured[mode] = parseKnipReport(JSON.parse(runKnip(MODE_ARGS[mode])), mode);
    } catch (error) {
      log(`knip: FAIL — cannot run or parse knip (${mode}): ${messageOf(error)}`);
      return 1;
    }
  }
  const findings: KnipBaseline = { default: measured.default ?? [], production: measured.production ?? [] };

  if (write) {
    writeFile(baselinePath, `${JSON.stringify(findings, null, 2)}\n`);
    log(`knip: wrote ${baselinePath}`);
    return 0;
  }

  let baseline: KnipBaseline;
  try {
    baseline = parseBaseline(JSON.parse(readFile(baselinePath)), baselinePath);
  } catch (error) {
    log(`knip: FAIL — cannot read baseline ${baselinePath}: ${messageOf(error)}`);
    return 1;
  }

  let failed = false;
  for (const mode of MODES) {
    log(`knip ${mode}: measured ${findings[mode].length} findings (baseline ${baseline[mode].length})`);
    const verdict = compareKnipFindings(findings[mode], baseline[mode]);
    if (verdict.kind === 'pass') continue;
    failed = true;
    if (verdict.added.length > 0) {
      log(`knip: FAIL — new finding(s) not in ${DEFAULT_BASELINE_PATH}; fix them (do not baseline new dead code):`);
      for (const key of verdict.added) log(`  ${key}`);
    }
    if (verdict.removed.length > 0) {
      log(`knip: FAIL — fixed finding(s) still in ${DEFAULT_BASELINE_PATH}; delete these entries:`);
      for (const key of verdict.removed) log(`  ${key}`);
    }
  }
  if (failed) return 1;
  log('knip: PASS');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = runKnipBaselineCli(process.argv.slice(2));
}
