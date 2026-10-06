import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  parseMutationFloors,
  parseMutationScore,
  readMutationScore,
  runMutationSummaryCli,
  summarizeStrykerReport,
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

const fixtureText = readFileSync(new URL('./fixtures/stryker-report.fixture.json', import.meta.url), 'utf8');
const fixture: unknown = JSON.parse(fixtureText);
const NAMES: Record<string, string> = { 'scbench-adapter': PKG, config: '@on-par/factory-config' };
const baseOptions = {
  floors: { '@on-par/factory-config': 70 },
  commit: 'abc123',
  measuredAt: '2026-10-06T00:00:00.000Z',
  packageNameOf: (dir: string) => NAMES[dir] ?? dir,
};
const reportWith = (files: Record<string, unknown>): unknown => ({ files });
const mutantsOf = (...statuses: unknown[]): { mutants: unknown[] } => ({
  mutants: statuses.map((status) => ({ status })),
});

describe('summarizeStrykerReport', () => {
  it('summarizes the fixture per package with null and numeric floors', () => {
    const { summary, warnings } = summarizeStrykerReport(fixture, baseOptions);
    expect(warnings).toEqual([]);
    expect(summary.packages).toEqual([
      {
        package: PKG,
        score: 75,
        floor: null,
        measuredAt: baseOptions.measuredAt,
        commit: 'abc123',
        mutants: 14,
        survived: 2,
        noCoverage: 1,
      },
      {
        package: '@on-par/factory-config',
        score: 75,
        floor: 70,
        measuredAt: baseOptions.measuredAt,
        commit: 'abc123',
        mutants: 4,
        survived: 1,
        noCoverage: 0,
      },
    ]);
    expect(summary.packages[0]?.floor).toBeNull();
    expect(summary.packages[0]?.floor).not.toBe(0);
    expect(validateMutationSummary(summary).ok).toBe(true);
  });

  it('skips files outside packages/ with a warning', () => {
    const { summary, warnings } = summarizeStrykerReport(
      reportWith({ 'scripts/x.ts': mutantsOf('Killed'), 'packages/config/src/c.ts': mutantsOf('Killed') }),
      baseOptions,
    );
    expect(summary.packages).toHaveLength(1);
    expect(warnings).toEqual(['skipped scripts/x.ts: not under packages/<dir>/']);
  });

  it('omits a package with no valid mutants and warns', () => {
    const { summary, warnings } = summarizeStrykerReport(
      reportWith({ 'packages/config/src/c.ts': mutantsOf('CompileError', 'Ignored') }),
      baseOptions,
    );
    expect(summary.packages).toEqual([]);
    expect(warnings).toEqual(['omitted @on-par/factory-config: no valid mutants to score']);
  });

  it('throws on an unknown or missing status, naming the path', () => {
    expect(() =>
      summarizeStrykerReport(reportWith({ 'packages/config/src/c.ts': mutantsOf('Bogus') }), baseOptions),
    ).toThrow(/packages\/config\/src\/c\.ts.*"Bogus"/);
    expect(() =>
      summarizeStrykerReport(reportWith({ 'packages/config/src/c.ts': { mutants: [{}] } }), baseOptions),
    ).toThrow(/unknown mutant status/);
  });

  it.each([null, {}, { files: [] }, { files: { x: {} } }])('throws on malformed report %j', (report) => {
    expect(() => summarizeStrykerReport(report, baseOptions)).toThrow();
  });

  it('maps Windows-style paths', () => {
    const { summary } = summarizeStrykerReport(
      reportWith({ 'packages\\config\\src\\c.ts': mutantsOf('Killed') }),
      baseOptions,
    );
    expect(summary.packages[0]?.package).toBe('@on-par/factory-config');
  });
});

describe('parseMutationFloors', () => {
  it('returns {} for undefined and empty text', () => {
    expect(parseMutationFloors(undefined)).toEqual({});
    expect(parseMutationFloors('')).toEqual({});
  });

  it('round-trips a valid map', () => {
    expect(parseMutationFloors('{"a":0,"b":100,"c":62.5}')).toEqual({ a: 0, b: 100, c: 62.5 });
  });

  it.each(['{nope', '[1]', '{"a":"70"}', '{"a":-1}', '{"a":101}'])('throws on %s', (text) => {
    expect(() => parseMutationFloors(text)).toThrow();
  });
});

describe('runMutationSummaryCli', () => {
  function harness(files: Record<string, string>, extra: Partial<Parameters<typeof runMutationSummaryCli>[1]> = {}) {
    const fs = new Map(Object.entries(files));
    const written = new Map<string, string>();
    const warns: string[] = [];
    const logs: string[] = [];
    const deps = {
      readFile: (p: string) => fs.get(p),
      writeFile: (p: string, t: string) => void written.set(p, t),
      gitHead: () => 'headsha',
      now: () => new Date('2026-10-05T12:00:00Z'),
      env: {},
      log: (l: string) => void logs.push(l),
      warn: (l: string) => void warns.push(l),
      ...extra,
    };
    return { deps, written, warns, logs };
  }
  const pkgFiles = {
    'r.json': fixtureText,
    'packages/scbench-adapter/package.json': JSON.stringify({ name: PKG }),
    'packages/config/package.json': JSON.stringify({ name: '@on-par/factory-config' }),
  };
  const read = (
    written: Map<string, string>,
  ): { packages: { floor: number | null; commit: string; measuredAt: string }[] } =>
    JSON.parse(written.get('out.json') ?? 'null');

  it('writes a valid summary on the happy path', () => {
    const h = harness({ ...pkgFiles, 'f.json': '{"@on-par/factory-config":70}' });
    const code = runMutationSummaryCli(
      [
        '--report',
        'r.json',
        '--out',
        'out.json',
        '--floors',
        'f.json',
        '--commit',
        'c1',
        '--measured-at',
        '2026-10-01T00:00:00Z',
      ],
      h.deps,
    );
    expect(code).toBe(0);
    const out = read(h.written);
    expect(validateMutationSummary(out).ok).toBe(true);
    expect(out.packages.map((p) => p.floor)).toEqual([null, 70]);
    expect(h.logs).toEqual(['wrote out.json: 2 package(s)']);
  });

  it('uses null floors and warns when there is no floors file', () => {
    const h = harness(pkgFiles);
    expect(runMutationSummaryCli(['--report', 'r.json', '--out', 'out.json', '--commit', 'c'], h.deps)).toBe(0);
    expect(read(h.written).packages.map((p) => p.floor)).toEqual([null, null]);
    expect(h.warns.some((w) => w.includes('no floors file'))).toBe(true);
  });

  it('falls back from GITHUB_SHA to git HEAD for the commit', () => {
    const a = harness(pkgFiles, { env: { GITHUB_SHA: 'envsha' } });
    runMutationSummaryCli(['--report', 'r.json', '--out', 'out.json'], a.deps);
    expect(read(a.written).packages[0]?.commit).toBe('envsha');
    const b = harness(pkgFiles);
    runMutationSummaryCli(['--report', 'r.json', '--out', 'out.json'], b.deps);
    expect(read(b.written).packages[0]?.commit).toBe('headsha');
  });

  it('defaults measuredAt to now()', () => {
    const h = harness(pkgFiles);
    runMutationSummaryCli(['--report', 'r.json', '--out', 'out.json', '--commit', 'c'], h.deps);
    expect(read(h.written).packages[0]?.measuredAt).toBe('2026-10-05T12:00:00.000Z');
  });

  it('returns 1 and writes nothing for a missing report', () => {
    const h = harness({});
    expect(runMutationSummaryCli(['--report', 'nope.json', '--out', 'out.json'], h.deps)).toBe(1);
    expect(h.written.size).toBe(0);
    expect(h.warns.join('\n')).toContain('stryker report not found at nope.json');
  });

  it('returns 1 for corrupt report JSON', () => {
    const h = harness({ 'r.json': '{oops' });
    expect(runMutationSummaryCli(['--report', 'r.json', '--out', 'out.json', '--commit', 'c'], h.deps)).toBe(1);
    expect(h.written.size).toBe(0);
  });

  it('returns 1 and writes nothing for an unknown status', () => {
    const bad = JSON.stringify(reportWith({ 'packages/config/src/c.ts': mutantsOf('Bogus') }));
    const h = harness({ ...pkgFiles, 'r.json': bad });
    expect(runMutationSummaryCli(['--report', 'r.json', '--out', 'out.json', '--commit', 'c'], h.deps)).toBe(1);
    expect(h.written.size).toBe(0);
    expect(h.warns.join('\n')).toContain('Bogus');
  });

  it('returns 2 for an unknown flag or a flag missing its value', () => {
    const h = harness(pkgFiles);
    expect(runMutationSummaryCli(['--nope'], h.deps)).toBe(2);
    expect(runMutationSummaryCli(['--report'], h.deps)).toBe(2);
    expect(h.written.size).toBe(0);
  });

  it('falls back to packages/<dir> with a warning when package.json is missing', () => {
    const h = harness({ 'r.json': fixtureText });
    expect(runMutationSummaryCli(['--report', 'r.json', '--out', 'out.json', '--commit', 'c'], h.deps)).toBe(0);
    expect(JSON.parse(h.written.get('out.json') ?? '').packages.map((p: { package: string }) => p.package)).toEqual([
      'packages/scbench-adapter',
      'packages/config',
    ]);
    expect(h.warns.some((w) => w.includes('packages/config/package.json'))).toBe(true);
  });
});
