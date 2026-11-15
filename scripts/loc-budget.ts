import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  defaultFetchLabelEvents,
  overrideLabelVerdict,
  parseArgs,
  type GuardIo,
  type OverrideVerdict,
} from './max-lines-baseline-guard.js';

export interface PackageLoc {
  source: number;
  tests: number;
}

export type LocBudget = Record<string, PackageLoc>;

export const LOC_BUDGET_FILE = 'loc-budget.json';
export const LOC_BUDGET_OVERRIDE_LABEL = 'loc-budget:override';
export const LOC_BUDGET_DOCS = '.claude/skills/verify/SKILL.md#loc-budget';

export type LocBudgetIo = GuardIo;

const USAGE = 'usage: loc-budget.ts [--print | --base <sha> --pr <number>]';
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
      failures.push(
        `packages/${pkg} has no ${LOC_BUDGET_FILE} entry; adding one needs the ${LOC_BUDGET_OVERRIDE_LABEL} label applied by a human; see ${LOC_BUDGET_DOCS}`,
      );
    } else if (want && !have) {
      failures.push(`${LOC_BUDGET_FILE} has an entry for packages/${pkg}, which does not exist; remove it`);
    } else if (want && have) {
      for (const kind of KINDS) {
        const n = have[kind];
        const b = want[kind];
        if (n > b) {
          failures.push(
            `packages/${pkg} ${kind} is ${n} lines, over its ${LOC_BUDGET_FILE} budget of ${b}. Delete or reuse existing code before adding more. If the growth is deliberate, set "${pkg}".${kind} to ${n} in ${LOC_BUDGET_FILE} and ask a human to apply the ${LOC_BUDGET_OVERRIDE_LABEL} label to the PR (agents never apply it); see ${LOC_BUDGET_DOCS}`,
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

export interface LocBudgetDiff {
  raised: { pkg: string; kind: keyof PackageLoc; base: number; head: number }[];
  added: string[];
}

export function diffLocBudget(base: Readonly<LocBudget>, head: Readonly<LocBudget>): LocBudgetDiff {
  const diff: LocBudgetDiff = { raised: [], added: [] };
  for (const [pkg, entry] of Object.entries(head)) {
    const before = base[pkg];
    if (!before) {
      diff.added.push(pkg);
      continue;
    }
    for (const kind of KINDS) {
      if (entry[kind] > before[kind]) diff.raised.push({ pkg, kind, base: before[kind], head: entry[kind] });
    }
  }
  return diff;
}

function diffLines(diff: LocBudgetDiff): string[] {
  return [
    ...diff.raised.map((r) => `${LOC_BUDGET_FILE} raised "${r.pkg}".${r.kind} from ${r.base} to ${r.head}`),
    ...diff.added.map((pkg) => `${LOC_BUDGET_FILE} added "${pkg}"`),
  ];
}

function runGuard(args: { base: string; pr: number }, io: LocBudgetIo, cwd: string, readHead: () => string): number {
  const log = io.log ?? ((line: string) => console.log(line));
  const error = io.error ?? ((line: string) => console.error(line));
  const env = io.env ?? process.env;
  const git = io.git ?? ((a: readonly string[]) => execFileSync('git', [...a], { cwd, encoding: 'utf8' }));
  let diff: LocBudgetDiff;
  try {
    const head = parseLocBudget(readHead(), 'head');
    if (git(['ls-tree', args.base, '--', LOC_BUDGET_FILE]).trim() === '') {
      log(`loc budget guard: ${LOC_BUDGET_FILE} is new at the base ref; nothing to compare`);
      return 0;
    }
    diff = diffLocBudget(parseLocBudget(git(['show', `${args.base}:${LOC_BUDGET_FILE}`]), 'base'), head);
  } catch (err) {
    error(`loc budget: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  if (diff.raised.length === 0 && diff.added.length === 0) {
    log('loc budget guard: no raised or added budgets');
    return 0;
  }
  const repo = env.GITHUB_REPOSITORY;
  if (!repo) {
    error('loc budget guard: GITHUB_REPOSITORY is not set');
    return 1;
  }
  let verdict: OverrideVerdict;
  try {
    const events = (io.fetchLabelEvents ?? defaultFetchLabelEvents)(repo, args.pr);
    verdict = overrideLabelVerdict(events, (env.LOC_BUDGET_BOT_LOGINS ?? '').split(','), LOC_BUDGET_OVERRIDE_LABEL);
  } catch (err) {
    error(`loc budget guard: could not read PR label events: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  const lines = diffLines(diff);
  if (verdict.kind === 'human') {
    for (const line of lines) log(line);
    log(`approved by ${verdict.actor} via ${LOC_BUDGET_OVERRIDE_LABEL}`);
    return 0;
  }
  for (const line of lines) error(line);
  error(
    verdict.kind === 'bot'
      ? `${LOC_BUDGET_OVERRIDE_LABEL} was applied by bot identity ${verdict.actor}; the label must be applied by a human`
      : `raising a ${LOC_BUDGET_FILE} budget needs the ${LOC_BUDGET_OVERRIDE_LABEL} label applied by a human`,
  );
  error(
    `delete or reuse existing code before adding; to request an override, explain the growth in the PR body and ask a human to apply ${LOC_BUDGET_OVERRIDE_LABEL}, then re-run the static job; see ${LOC_BUDGET_DOCS}`,
  );
  return 1;
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
  const args = parseArgs(argv);
  if (!args) {
    error(USAGE);
    return 2;
  }
  return runGuard(args, io, cwd, readHead);
}

const invoked = process.argv[1];
if (invoked && import.meta.url === pathToFileURL(resolve(invoked)).href) {
  process.exitCode = runLocBudget(process.argv.slice(2));
}
