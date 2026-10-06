// scripts/mutation-summary.ts — Format and safe reader for the weekly per-package mutation summary.
//
// See #1949 (weekly Stryker evidence), #2130 (format and reader) and #2132 (the producer that converts
// a Stryker JSON report into mutation-summary.json). Consumers such as the trust-ladder
// report (#1741) read a package's score through readMutationScore. Absent, corrupt, invalid or
// stale evidence is 'unknown', never 0.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** One package's mutation evidence, as written by the weekly Stryker run (#1949). */
export interface MutationPackageSummary {
  package: string;
  score: number;
  floor: number | null;
  measuredAt: string;
  commit: string;
  mutants: number;
  survived: number;
  noCoverage: number;
}

export interface MutationSummary {
  packages: MutationPackageSummary[];
}

/** A package's score, or 'unknown' when evidence is absent, invalid or stale. Never 0 for missing evidence. */
export type MutationScore = number | 'unknown';

export type MutationValidationResult = { ok: true; summary: MutationSummary } | { ok: false; errors: string[] };

export interface ReadMutationScoreOptions {
  /** Evidence older than this many days is 'unknown'. Default DEFAULT_MUTATION_MAX_AGE_DAYS. */
  maxAgeDays?: number;
  /** Clock for the staleness check. Default new Date(). */
  now?: Date;
}

/** Two weekly mutation runs: one missed run still counts as fresh. */
export const DEFAULT_MUTATION_MAX_AGE_DAYS = 14;

const MS_PER_DAY = 86_400_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPercent(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

export function validateMutationSummary(value: unknown): MutationValidationResult {
  if (!isRecord(value)) return { ok: false, errors: ['summary must be an object'] };
  const raw = value.packages;
  if (!Array.isArray(raw)) return { ok: false, errors: ['packages must be an array'] };

  const errors: string[] = [];
  const packages: MutationPackageSummary[] = [];
  const seen = new Set<string>();
  raw.forEach((entry: unknown, i) => {
    const at = `packages[${i}]`;
    if (!isRecord(entry)) {
      errors.push(`${at} must be an object`);
      return;
    }
    const before = errors.length;
    if (!isNonEmptyString(entry.package)) errors.push(`${at}.package must be a non-empty string`);
    else if (seen.has(entry.package)) errors.push(`${at}.package duplicates "${entry.package}"`);
    else seen.add(entry.package);
    if (!isPercent(entry.score)) errors.push(`${at}.score must be a number between 0 and 100`);
    if (!('floor' in entry) || (entry.floor !== null && !isPercent(entry.floor))) {
      errors.push(`${at}.floor must be null or a number between 0 and 100`);
    }
    if (typeof entry.measuredAt !== 'string' || Number.isNaN(Date.parse(entry.measuredAt))) {
      errors.push(`${at}.measuredAt must be an ISO-8601 timestamp`);
    }
    if (!isNonEmptyString(entry.commit)) errors.push(`${at}.commit must be a non-empty string`);
    for (const key of ['mutants', 'survived', 'noCoverage'] as const) {
      if (!isCount(entry[key])) errors.push(`${at}.${key} must be a non-negative integer`);
    }
    if (errors.length === before) {
      packages.push({
        package: entry.package as string,
        score: entry.score as number,
        floor: entry.floor as number | null,
        measuredAt: entry.measuredAt as string,
        commit: entry.commit as string,
        mutants: entry.mutants as number,
        survived: entry.survived as number,
        noCoverage: entry.noCoverage as number,
      });
    }
  });
  return errors.length > 0 ? { ok: false, errors } : { ok: true, summary: { packages } };
}

export function parseMutationScore(
  text: string | undefined,
  pkg: string,
  options: ReadMutationScoreOptions = {},
): MutationScore {
  const maxAgeDays = options.maxAgeDays ?? DEFAULT_MUTATION_MAX_AGE_DAYS;
  if (!Number.isFinite(maxAgeDays) || maxAgeDays <= 0) throw new RangeError('maxAgeDays must be a positive number');
  const now = options.now ?? new Date();

  if (text === undefined || text.trim() === '') return 'unknown';
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return 'unknown';
  }
  const result = validateMutationSummary(parsed);
  if (!result.ok) return 'unknown';
  const entry = result.summary.packages.find((p) => p.package === pkg);
  if (!entry) return 'unknown';

  const ageMs = now.getTime() - Date.parse(entry.measuredAt);
  if (ageMs < 0 || ageMs > maxAgeDays * MS_PER_DAY) return 'unknown';
  return entry.score;
}

export function readMutationScore(path: string, pkg: string, options?: ReadMutationScoreOptions): MutationScore {
  let text: string | undefined;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    text = undefined;
  }
  return parseMutationScore(text, pkg, options);
}

/** MutantStatus enum of mutation-testing-report-schema. */
const STRYKER_STATUSES = [
  'Killed',
  'Survived',
  'NoCoverage',
  'CompileError',
  'RuntimeError',
  'Timeout',
  'Ignored',
  'Pending',
] as const;

/** Recorded ratchet floors (#804), keyed by package name. A package absent here has floor null. */
export type MutationFloors = Record<string, number>;

export interface SummarizeOptions {
  floors: MutationFloors;
  commit: string;
  measuredAt: string;
  /** Maps a workspace dir under packages/ (e.g. "scbench-adapter") to its package name. */
  packageNameOf: (dir: string) => string;
}

export interface MutationSummaryCliDeps {
  /** undefined when the file is absent or unreadable. */
  readFile: (path: string) => string | undefined;
  writeFile: (path: string, text: string) => void;
  gitHead: () => string;
  now: () => Date;
  env: NodeJS.ProcessEnv;
  log: (line: string) => void;
  warn: (line: string) => void;
}

interface PackageCounts {
  mutants: number;
  killed: number;
  timeout: number;
  survived: number;
  noCoverage: number;
}

function isStrykerStatus(value: unknown): value is (typeof STRYKER_STATUSES)[number] {
  return typeof value === 'string' && (STRYKER_STATUSES as readonly string[]).includes(value);
}

export function summarizeStrykerReport(
  report: unknown,
  options: SummarizeOptions,
): { summary: MutationSummary; warnings: string[] } {
  if (!isRecord(report) || !isRecord(report.files)) {
    throw new Error('stryker report must be an object with a files object');
  }
  const warnings: string[] = [];
  const counts = new Map<string, PackageCounts>();

  for (const [path, file] of Object.entries(report.files)) {
    if (!isRecord(file) || !Array.isArray(file.mutants)) {
      throw new Error(`${path}: stryker file entry must be an object with a mutants array`);
    }
    const match = /^packages\/([^/]+)\//.exec(path.replace(/\\/g, '/'));
    if (!match) {
      warnings.push(`skipped ${path}: not under packages/<dir>/`);
      continue;
    }
    const pkg = options.packageNameOf(match[1] as string);
    let c = counts.get(pkg);
    if (!c) {
      c = { mutants: 0, killed: 0, timeout: 0, survived: 0, noCoverage: 0 };
      counts.set(pkg, c);
    }
    for (const mutant of file.mutants as unknown[]) {
      const status = isRecord(mutant) ? mutant.status : undefined;
      if (!isStrykerStatus(status)) throw new Error(`${path}: unknown mutant status ${JSON.stringify(status)}`);
      c.mutants++;
      if (status === 'Killed') c.killed++;
      else if (status === 'Timeout') c.timeout++;
      else if (status === 'Survived') c.survived++;
      else if (status === 'NoCoverage') c.noCoverage++;
    }
  }

  const packages: MutationPackageSummary[] = [];
  for (const [pkg, c] of counts) {
    const valid = c.killed + c.timeout + c.survived + c.noCoverage;
    if (valid === 0) {
      warnings.push(`omitted ${pkg}: no valid mutants to score`);
      continue;
    }
    packages.push({
      package: pkg,
      score: Math.round((10000 * (c.killed + c.timeout)) / valid) / 100,
      floor: Object.hasOwn(options.floors, pkg) ? (options.floors[pkg] as number) : null,
      measuredAt: options.measuredAt,
      commit: options.commit,
      mutants: c.mutants,
      survived: c.survived,
      noCoverage: c.noCoverage,
    });
  }
  return { summary: { packages }, warnings };
}

export function parseMutationFloors(text: string | undefined): MutationFloors {
  if (text === undefined || text.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('mutation floors must be a JSON object of package -> number');
  }
  if (!isRecord(parsed)) throw new Error('mutation floors must be a JSON object of package -> number');
  const floors: MutationFloors = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (!isPercent(v)) throw new Error(`floor for ${k} must be a number between 0 and 100`);
    floors[k] = v;
  }
  return floors;
}

export function runMutationSummaryCli(argv: string[], deps: Partial<MutationSummaryCliDeps> = {}): number {
  const d: MutationSummaryCliDeps = {
    readFile: (p) => {
      try {
        return readFileSync(p, 'utf8');
      } catch {
        return undefined;
      }
    },
    writeFile: (p, text) => writeFileSync(p, text),
    gitHead: () => execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    now: () => new Date(),
    env: process.env,
    log: console.log,
    warn: console.error,
    ...deps,
  };

  const flags: Record<string, string | undefined> = {
    '--report': 'reports/mutation/mutation.json',
    '--out': 'mutation-summary.json',
    '--floors': 'mutation-floors.json',
    '--commit': undefined,
    '--measured-at': undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    const value = argv[i + 1];
    if (!(arg in flags)) {
      d.warn(`unknown flag: ${arg}`);
      return 2;
    }
    if (value === undefined) {
      d.warn(`flag ${arg} requires a value`);
      return 2;
    }
    flags[arg] = value;
    i++;
  }
  const reportPath = flags['--report'] as string;
  const outPath = flags['--out'] as string;
  const floorsPath = flags['--floors'] as string;

  const packageNameOf = (dir: string): string => {
    const text = d.readFile(`packages/${dir}/package.json`);
    try {
      const name = text === undefined ? undefined : (JSON.parse(text) as { name?: unknown }).name;
      if (isNonEmptyString(name)) return name;
    } catch {
      // fall through to the directory-based name
    }
    d.warn(`packages/${dir}/package.json has no readable name; using packages/${dir}`);
    return `packages/${dir}`;
  };

  try {
    const reportText = d.readFile(reportPath);
    if (reportText === undefined) {
      d.warn(`stryker report not found at ${reportPath} — run \`npm run mutation\` with the json reporter first`);
      return 1;
    }
    const report: unknown = JSON.parse(reportText);
    const floorsText = d.readFile(floorsPath);
    if (floorsText === undefined) d.warn(`no floors file at ${floorsPath}; every floor is null`);
    const floors = parseMutationFloors(floorsText);
    const { summary, warnings } = summarizeStrykerReport(report, {
      floors,
      commit: flags['--commit'] ?? d.env.GITHUB_SHA ?? d.gitHead(),
      measuredAt: flags['--measured-at'] ?? d.now().toISOString(),
      packageNameOf,
    });
    for (const w of warnings) d.warn(w);
    const result = validateMutationSummary(summary);
    if (!result.ok) {
      for (const e of result.errors) d.warn(e);
      return 1;
    }
    d.writeFile(outPath, JSON.stringify(summary, null, 2) + '\n');
    d.log(`wrote ${outPath}: ${summary.packages.length} package(s)`);
    return 0;
  } catch (err) {
    d.warn(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = runMutationSummaryCli(process.argv.slice(2));
}
