// scripts/mutation-summary.ts — Format and safe reader for the weekly per-package mutation summary.
//
// See #1949 (weekly Stryker evidence) and #2130 (this slice). Consumers such as the trust-ladder
// report (#1741) read a package's score through readMutationScore. Absent, corrupt, invalid or
// stale evidence is 'unknown', never 0.

import { readFileSync } from 'node:fs';

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
