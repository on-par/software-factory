import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  parseMutationScore,
  readMutationScore,
  validateMutationSummary,
  type MutationPackageSummary,
} from './mutation-summary.js';

const now = new Date('2026-10-06T00:00:00Z');
const PKG = '@on-par/scbench-adapter';
const DAY = 86_400_000;

function entry(overrides: Partial<MutationPackageSummary> = {}): MutationPackageSummary {
  return {
    package: PKG,
    score: 72.5,
    floor: null,
    measuredAt: '2026-10-01T00:00:00Z',
    commit: 'abc123',
    mutants: 200,
    survived: 40,
    noCoverage: 15,
    ...overrides,
  };
}

const summaryText = (...entries: unknown[]): string => JSON.stringify({ packages: entries });
const daysAgo = (n: number): string => new Date(now.getTime() - n * DAY).toISOString();

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'mutation-summary-'));
  dirs.push(d);
  return d;
}

describe('validateMutationSummary', () => {
  it('accepts a null floor and a numeric floor', () => {
    expect(validateMutationSummary({ packages: [entry()] }).ok).toBe(true);
    expect(validateMutationSummary({ packages: [entry({ floor: 60 })] }).ok).toBe(true);
  });

  it.each(['package', 'score', 'floor', 'measuredAt', 'commit', 'mutants', 'survived', 'noCoverage'])(
    'rejects an entry missing %s',
    (field) => {
      const e: Record<string, unknown> = { ...entry() };
      delete e[field];
      const result = validateMutationSummary({ packages: [e] });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.join('\n')).toContain(`packages[0].${field}`);
    },
  );

  it('rejects malformed input', () => {
    expect(validateMutationSummary(null).ok).toBe(false);
    expect(validateMutationSummary([]).ok).toBe(false);
    expect(validateMutationSummary({}).ok).toBe(false);
    expect(validateMutationSummary({ packages: {} }).ok).toBe(false);
    expect(validateMutationSummary({ packages: ['x'] }).ok).toBe(false);
    expect(validateMutationSummary({ packages: [entry({ score: 101 })] }).ok).toBe(false);
    expect(validateMutationSummary({ packages: [entry({ mutants: -1 })] }).ok).toBe(false);
    expect(validateMutationSummary({ packages: [entry({ mutants: 1.5 })] }).ok).toBe(false);
    expect(validateMutationSummary({ packages: [entry({ measuredAt: 'nope' })] }).ok).toBe(false);
  });

  it('rejects duplicate package names', () => {
    const result = validateMutationSummary({ packages: [entry(), entry()] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain(`packages[1].package duplicates "${PKG}"`);
  });
});

describe('readMutationScore', () => {
  it('returns the score of a fresh summary', () => {
    const path = join(tmp(), 's.json');
    writeFileSync(path, summaryText(entry()));
    expect(readMutationScore(path, PKG, { now })).toBe(72.5);
  });

  it('returns 0 for a real zero measurement', () => {
    const path = join(tmp(), 's.json');
    writeFileSync(path, summaryText(entry({ score: 0 })));
    expect(readMutationScore(path, PKG, { now })).toBe(0);
  });

  it('returns unknown, not 0, for an absent file', () => {
    const result = readMutationScore(join(tmp(), 'missing.json'), PKG, { now });
    expect(result).toBe('unknown');
    expect(result).not.toBe(0);
  });

  it('returns unknown when the path is unreadable', () => {
    expect(readMutationScore(tmp(), PKG, { now })).toBe('unknown');
  });
});

describe('parseMutationScore', () => {
  it('returns unknown for missing, empty, corrupt and invalid text', () => {
    expect(parseMutationScore(undefined, PKG, { now })).toBe('unknown');
    expect(parseMutationScore('  ', PKG, { now })).toBe('unknown');
    expect(parseMutationScore('{nope', PKG, { now })).toBe('unknown');
    expect(parseMutationScore('{"packages":[{"package":"x"}]}', PKG, { now })).toBe('unknown');
  });

  it('returns unknown for a stale summary by default', () => {
    expect(parseMutationScore(summaryText(entry({ measuredAt: daysAgo(15) })), PKG, { now })).toBe('unknown');
  });

  it('honours a configurable window', () => {
    const old = summaryText(entry({ measuredAt: daysAgo(15) }));
    expect(parseMutationScore(old, PKG, { now, maxAgeDays: 30 })).toBe(72.5);
    expect(parseMutationScore(summaryText(entry({ measuredAt: daysAgo(3) })), PKG, { now, maxAgeDays: 2 })).toBe(
      'unknown',
    );
    expect(parseMutationScore(summaryText(entry({ measuredAt: daysAgo(2) })), PKG, { now, maxAgeDays: 2 })).toBe(72.5);
  });

  it('returns unknown for a future-dated measurement', () => {
    expect(parseMutationScore(summaryText(entry({ measuredAt: daysAgo(-1) })), PKG, { now })).toBe('unknown');
  });

  it('returns unknown for a package not in the summary', () => {
    expect(parseMutationScore(summaryText(entry()), '@on-par/other', { now })).toBe('unknown');
  });

  it.each([0, -1, Number.NaN])('throws RangeError for maxAgeDays %s', (maxAgeDays) => {
    expect(() => parseMutationScore(undefined, PKG, { now, maxAgeDays })).toThrow(RangeError);
  });
});
