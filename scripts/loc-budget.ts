import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface PackageLoc {
  source: number;
  tests: number;
}

export type LocBudget = Record<string, PackageLoc>;

export const LOC_BUDGET_FILE = 'loc-budget.json';
export const LOC_BUDGET_DOCS = '.claude/skills/verify/SKILL.md#loc-budget';

export interface LocBudgetIo {
  cwd?: string;
  readHead?: () => string;
  log?: (line: string) => void;
  error?: (line: string) => void;
}

const USAGE = 'usage: loc-budget.ts [--print]';
const KINDS = ['source', 'tests'] as const;
const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'coverage']);
const TS_FILE = /\.(?:ts|tsx|mts|cts)$/;
const TEST_FILE = /\.test\.(?:ts|tsx|mts|cts)$/;

export function countLines(text: string): number {
  const lines = text.split('\n');
  return lines.at(-1) === '' ? lines.length - 1 : lines.length;
}

function measureDir(dir: string, loc: PackageLoc): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || SKIPPED_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      measureDir(path, loc);
    } else if (entry.isFile() && TS_FILE.test(entry.name)) {
      const lines = countLines(readFileSync(path, 'utf8'));
      if (TEST_FILE.test(entry.name)) loc.tests += lines;
      else loc.source += lines;
    }
  }
}

export function measurePackages(root: string): LocBudget {
  const packagesDir = join(root, 'packages');
  const names = readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(packagesDir, entry.name, 'package.json')))
    .map((entry) => entry.name)
    .sort();
  const out: LocBudget = {};
  for (const name of names) {
    const loc: PackageLoc = { source: 0, tests: 0 };
    measureDir(join(packagesDir, name), loc);
    out[name] = loc;
  }
  return out;
}

export function parseLocBudget(text: string, label: string): LocBudget {
  const value: unknown = JSON.parse(text);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} ${LOC_BUDGET_FILE} must be a JSON object`);
  }
  const out: LocBudget = {};
  for (const [pkg, entry] of Object.entries(value)) {
    const source: unknown = entry?.source;
    const tests: unknown = entry?.tests;
    if (!isCount(source) || !isCount(tests)) {
      throw new Error(`${label} ${LOC_BUDGET_FILE} entry ${pkg} must be {source, tests} non-negative integers`);
    }
    out[pkg] = { source, tests };
  }
  return out;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

export function compareLocBudget(budget: Readonly<LocBudget>, actual: Readonly<LocBudget>): string[] {
  const failures: string[] = [];
  const packages = [...new Set([...Object.keys(actual), ...Object.keys(budget)])].sort();
  for (const pkg of packages) {
    const have = actual[pkg];
    const want = budget[pkg];
    if (!want && have) {
      failures.push(`packages/${pkg} has no ${LOC_BUDGET_FILE} entry; add one; see ${LOC_BUDGET_DOCS}`);
    } else if (want && !have) {
      failures.push(`${LOC_BUDGET_FILE} has an entry for packages/${pkg}, which does not exist; remove it`);
    } else if (want && have) {
      for (const kind of KINDS) {
        const n = have[kind];
        const b = want[kind];
        if (n > b) {
          failures.push(
            `packages/${pkg} ${kind} is ${n} lines, over its ${LOC_BUDGET_FILE} budget of ${b}. Delete or reuse existing code before adding more. If the growth is deliberate, set "${pkg}".${kind} to ${n} in ${LOC_BUDGET_FILE} and explain the growth in the PR body; see ${LOC_BUDGET_DOCS}`,
          );
        } else if (n < b) {
          failures.push(
            `packages/${pkg} ${kind} is ${n} lines, under its ${LOC_BUDGET_FILE} budget of ${b}; lower "${pkg}".${kind} to ${n} in ${LOC_BUDGET_FILE} in this PR so the trimmed code stays gone; see ${LOC_BUDGET_DOCS}`,
          );
        }
      }
    }
  }
  return failures;
}

export function runLocBudget(argv: readonly string[], io: LocBudgetIo = {}): number {
  const log = io.log ?? ((line: string) => console.log(line));
  const error = io.error ?? ((line: string) => console.error(line));
  const cwd = io.cwd ?? process.cwd();
  const readHead = io.readHead ?? (() => readFileSync(resolve(cwd, LOC_BUDGET_FILE), 'utf8'));
  if (argv.length === 1 && argv[0] === '--print') {
    log(JSON.stringify(measurePackages(cwd), null, 2));
    return 0;
  }
  if (argv.length === 0) {
    try {
      const actual = measurePackages(cwd);
      const failures = compareLocBudget(parseLocBudget(readHead(), 'head'), actual);
      if (failures.length > 0) {
        for (const line of failures) error(line);
        return 1;
      }
      const all = Object.values(actual);
      const source = all.reduce((sum, p) => sum + p.source, 0);
      const tests = all.reduce((sum, p) => sum + p.tests, 0);
      log(`loc budget: PASS (${all.length} packages, ${source} source + ${tests} test lines)`);
      return 0;
    } catch (err) {
      error(`loc budget: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }
  error(USAGE);
  return 2;
}

const invoked = process.argv[1];
if (invoked && import.meta.url === pathToFileURL(resolve(invoked)).href) {
  process.exitCode = runLocBudget(process.argv.slice(2));
}
