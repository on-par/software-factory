import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { overrideLabelVerdict } from './max-lines-baseline-guard.js';
import type { LabelEvent, OverrideVerdict } from './max-lines-baseline-guard.js';

export const LOC_BUDGET_FILE = 'loc-budget.json';
export const LOC_BUDGET_OVERRIDE_LABEL = 'loc-budget:override';
export const LOC_BUDGET_DOCS = '.claude/skills/verify/SKILL.md#line-budget';

export type LocKind = 'source' | 'tests';
export type LocBudget = Record<string, { source: number; tests: number }>;
export type LocBudgetFinding =
  | { pkg: string; kind: LocKind; budget: number; actual: number; problem: 'over' | 'under' }
  | { pkg: string; problem: 'missing-from-budget' | 'unknown-package' };

export interface LocBudgetRaise {
  pkg: string;
  kind: LocKind;
  base: number | undefined;
  head: number;
}

export interface LocBudgetIo {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  git?: (args: readonly string[]) => string;
  readFile?: (path: string) => string;
  listPackages?: () => string[];
  fetchLabelEvents?: (repo: string, pr: number) => LabelEvent[];
  log?: (line: string) => void;
  error?: (line: string) => void;
}

const USAGE = 'usage: loc-budget.ts [--base <sha> --pr <number>]';
const KINDS: readonly LocKind[] = ['source', 'tests'];
const TS_EXTENSION = /\.(ts|tsx|mts|cts)$/;
const TEST_FILE = /\.(test|spec)\.(ts|tsx|mts|cts)$/;

export function countLines(text: string): number {
  const lines = text.split('\n');
  return lines.at(-1) === '' ? lines.length - 1 : lines.length;
}

export function classifyPath(path: string): { pkg: string; kind: LocKind } | undefined {
  const match = /^packages\/([^/]+)\/(.+)$/.exec(path);
  if (!match) return undefined;
  const pkg = match[1] ?? '';
  const rest = match[2] ?? '';
  if (rest.split('/').some((segment) => segment === 'dist' || segment === 'node_modules')) return undefined;
  if (!TS_EXTENSION.test(rest)) return undefined;
  return { pkg, kind: TEST_FILE.test(rest) ? 'tests' : 'source' };
}

export function countPackageLines(paths: readonly string[], read: (path: string) => string): LocBudget {
  const out: LocBudget = {};
  for (const path of paths) {
    const hit = classifyPath(path);
    if (!hit) continue;
    const entry = (out[hit.pkg] ??= { source: 0, tests: 0 });
    entry[hit.kind] += countLines(read(path));
  }
  return out;
}

export function compareLocBudget(
  budget: Readonly<LocBudget>,
  actual: Readonly<LocBudget>,
  packages: readonly string[],
): LocBudgetFinding[] {
  const findings: LocBudgetFinding[] = [];
  for (const pkg of packages) {
    const recorded = budget[pkg];
    if (!recorded) {
      findings.push({ pkg, problem: 'missing-from-budget' });
      continue;
    }
    const counted = actual[pkg] ?? { source: 0, tests: 0 };
    for (const kind of KINDS) {
      if (counted[kind] > recorded[kind]) {
        findings.push({ pkg, kind, budget: recorded[kind], actual: counted[kind], problem: 'over' });
      } else if (counted[kind] < recorded[kind]) {
        findings.push({ pkg, kind, budget: recorded[kind], actual: counted[kind], problem: 'under' });
      }
    }
  }
  for (const pkg of Object.keys(budget)) {
    if (!packages.includes(pkg)) findings.push({ pkg, problem: 'unknown-package' });
  }
  return findings;
}

export function diffLocBudget(base: Readonly<LocBudget>, head: Readonly<LocBudget>): LocBudgetRaise[] {
  const raises: LocBudgetRaise[] = [];
  for (const [pkg, entry] of Object.entries(head)) {
    for (const kind of KINDS) {
      const before = base[pkg]?.[kind];
      if (before === undefined || entry[kind] > before) raises.push({ pkg, kind, base: before, head: entry[kind] });
    }
  }
  return raises;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
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
      throw new Error(`${label} ${LOC_BUDGET_FILE} entry ${pkg} must have non-negative integer source and tests`);
    }
    out[pkg] = { source, tests };
  }
  return out;
}

function renderFinding(finding: LocBudgetFinding): string {
  if (finding.problem === 'over') {
    return `packages/${finding.pkg} ${finding.kind} is ${finding.actual} lines, over its ${LOC_BUDGET_FILE} budget of ${finding.budget}; delete or reuse existing code before adding more. To grow a package on purpose, raise the number in ${LOC_BUDGET_FILE} and ask a human to apply the ${LOC_BUDGET_OVERRIDE_LABEL} label (agents never apply it); see ${LOC_BUDGET_DOCS}`;
  }
  if (finding.problem === 'under') {
    return `packages/${finding.pkg} ${finding.kind} is ${finding.actual} lines, under its ${LOC_BUDGET_FILE} budget of ${finding.budget}; lower the recorded number to ${finding.actual} in this PR (the budget only falls); see ${LOC_BUDGET_DOCS}`;
  }
  if (finding.problem === 'missing-from-budget') {
    return `packages/${finding.pkg} has no entry in ${LOC_BUDGET_FILE}; add one with its line counts (adding an entry needs the ${LOC_BUDGET_OVERRIDE_LABEL} label applied by a human); see ${LOC_BUDGET_DOCS}`;
  }
  return `${LOC_BUDGET_FILE} lists ${finding.pkg} but packages/${finding.pkg} does not exist; remove the entry (removing is free, re-adding it needs the ${LOC_BUDGET_OVERRIDE_LABEL} label); see ${LOC_BUDGET_DOCS}`;
}

function raiseLines(raises: readonly LocBudgetRaise[]): string[] {
  return raises.map((r) => `${LOC_BUDGET_FILE} raised ${r.pkg}.${r.kind} from ${r.base ?? 'none'} to ${r.head}`);
}

export function renderLocBudgetFailure(
  findings: readonly LocBudgetFinding[],
  raises: readonly LocBudgetRaise[],
  verdict: OverrideVerdict,
): string[] {
  const lines = findings.map(renderFinding);
  if (raises.length === 0) return lines;
  lines.push(...raiseLines(raises));
  if (verdict.kind === 'bot') {
    lines.push(
      `${LOC_BUDGET_OVERRIDE_LABEL} was applied by bot identity ${verdict.actor}; the label must be applied by a human`,
    );
  } else {
    lines.push(
      `raising or adding a ${LOC_BUDGET_FILE} entry needs the ${LOC_BUDGET_OVERRIDE_LABEL} label applied by a human`,
    );
  }
  lines.push(`delete or reuse existing code instead, or see ${LOC_BUDGET_DOCS}`);
  return lines;
}

function parseArgs(argv: readonly string[]): { base: string; pr: number } | undefined | null {
  if (argv.length === 0) return null;
  const [baseFlag, base, prFlag, pr, ...rest] = argv;
  if (baseFlag !== '--base' || prFlag !== '--pr' || !base || !pr || rest.length > 0) return undefined;
  const number = Number(pr);
  return Number.isInteger(number) && number > 0 ? { base, pr: number } : undefined;
}

function defaultFetchLabelEvents(repo: string, pr: number): LabelEvent[] {
  const out = execFileSync('gh', ['api', '--paginate', '--slurp', `repos/${repo}/issues/${pr}/events`], {
    encoding: 'utf8',
  });
  const pages: unknown = JSON.parse(out);
  return (Array.isArray(pages) ? pages.flat() : []) as LabelEvent[];
}

function defaultListPackages(cwd: string): string[] {
  const root = resolve(cwd, 'packages');
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(resolve(root, d.name, 'package.json')))
    .map((d) => d.name)
    .sort();
}

export function runLocBudget(argv: readonly string[], io: LocBudgetIo = {}): number {
  const log = io.log ?? ((line: string) => console.log(line));
  const error = io.error ?? ((line: string) => console.error(line));
  const args = parseArgs(argv);
  if (args === undefined) {
    error(USAGE);
    return 2;
  }
  const cwd = io.cwd ?? process.cwd();
  const env = io.env ?? process.env;
  const git = io.git ?? ((a: readonly string[]) => execFileSync('git', [...a], { cwd, encoding: 'utf8' }));
  const readFile = io.readFile ?? ((path: string) => readFileSync(resolve(cwd, path), 'utf8'));
  const listPackages = io.listPackages ?? (() => defaultListPackages(cwd));

  let head: LocBudget;
  let base: LocBudget = {};
  let findings: LocBudgetFinding[];
  try {
    const listed = git(['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', 'packages']);
    const paths = listed.split('\0').filter((p) => p !== '');
    const actual = countPackageLines(paths, readFile);
    head = parseLocBudget(readFile(LOC_BUDGET_FILE), 'head');
    findings = compareLocBudget(head, actual, listPackages());
    if (args) {
      git(['rev-parse', '--verify', `${args.base}^{commit}`]);
      let baseHasBudget = true;
      try {
        git(['cat-file', '-e', `${args.base}:${LOC_BUDGET_FILE}`]);
      } catch {
        baseHasBudget = false;
      }
      base = baseHasBudget ? parseLocBudget(git(['show', `${args.base}:${LOC_BUDGET_FILE}`]), 'base') : head;
    }
  } catch (err) {
    error(`loc-budget: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  if (findings.length > 0) {
    for (const line of renderLocBudgetFailure(findings, [], { kind: 'absent' })) error(line);
    return 1;
  }
  if (!args) {
    log('loc-budget: every package matches loc-budget.json');
    return 0;
  }

  const raises = diffLocBudget(base, head);
  if (raises.length === 0) {
    log('loc-budget: every package matches loc-budget.json; no raised or added entries');
    return 0;
  }
  const repo = env.GITHUB_REPOSITORY;
  if (!repo) {
    error('loc-budget: GITHUB_REPOSITORY is not set');
    return 1;
  }
  let verdict: OverrideVerdict;
  try {
    const events = (io.fetchLabelEvents ?? defaultFetchLabelEvents)(repo, args.pr);
    verdict = overrideLabelVerdict(events, (env.LOC_BUDGET_BOT_LOGINS ?? '').split(','), LOC_BUDGET_OVERRIDE_LABEL);
  } catch (err) {
    error(`loc-budget: could not read PR label events: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  if (verdict.kind === 'human') {
    log(
      `loc-budget: ${raises.length} raised/added entries approved by ${verdict.actor} via ${LOC_BUDGET_OVERRIDE_LABEL}`,
    );
    for (const line of raiseLines(raises)) log(line);
    return 0;
  }
  for (const line of renderLocBudgetFailure([], raises, verdict)) error(line);
  return 1;
}

const invoked = process.argv[1];
if (invoked && import.meta.url === pathToFileURL(resolve(invoked)).href) {
  process.exitCode = runLocBudget(process.argv.slice(2));
}
