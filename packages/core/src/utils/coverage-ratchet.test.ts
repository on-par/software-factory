import { describe, expect, it } from 'vitest';
import {
  checkRatchetDrift,
  checkScopedRatchetDrift,
  DEFAULT_RATCHET_SLACK,
  parseCoverageSummary,
  parseCoverageSummaryScopes,
  renderRatchetReport,
  type CoverageMetrics,
  type RatchetCheckResult,
} from './coverage-ratchet.js';

function summaryJson(metrics: Record<keyof CoverageMetrics, { total: number; covered: number; pct: number }>): string {
  return JSON.stringify({ total: metrics });
}

describe('parseCoverageSummary', () => {
  it('parses a valid summary into the four pct values', () => {
    const json = summaryJson({
      lines: { total: 100, covered: 95, pct: 95.31 },
      functions: { total: 50, covered: 46, pct: 92 },
      branches: { total: 40, covered: 35, pct: 87.5 },
      statements: { total: 100, covered: 95, pct: 95.31 },
    });

    expect(parseCoverageSummary(json)).toEqual({
      lines: 95.31,
      functions: 92,
      branches: 87.5,
      statements: 95.31,
    });
  });

  it('throws on invalid JSON', () => {
    expect(() => parseCoverageSummary('{not json')).toThrow(/not valid JSON/);
  });

  it('throws when the total block is missing', () => {
    expect(() => parseCoverageSummary('{}')).toThrow(/missing a "total" block/);
  });

  it('throws when a metric has a missing pct', () => {
    const json = summaryJson({
      lines: { total: 100, covered: 95, pct: 95.31 },
      functions: { total: 50, covered: 46, pct: 92 },
      branches: { total: 40, covered: 35, pct: 87.5 },
      statements: { total: 100, covered: 95, pct: undefined as unknown as number },
    });

    expect(() => parseCoverageSummary(json)).toThrow(/statements\.pct/);
  });

  it('throws when a metric has a non-numeric pct', () => {
    const json = JSON.stringify({
      total: {
        lines: { total: 100, covered: 95, pct: 95.31 },
        functions: { total: 50, covered: 46, pct: 92 },
        branches: { total: 40, covered: 35, pct: 87.5 },
        statements: { total: 100, covered: 95, pct: 'oops' },
      },
    });

    expect(() => parseCoverageSummary(json)).toThrow(/statements\.pct/);
  });
});

describe('parseCoverageSummaryScopes', () => {
  it('aggregates package-scoped threshold globs from file entries', () => {
    const json = JSON.stringify({
      total: {
        lines: { total: 300, covered: 270, pct: 90 },
        functions: { total: 30, covered: 24, pct: 80 },
        branches: { total: 20, covered: 10, pct: 50 },
        statements: { total: 300, covered: 270, pct: 90 },
      },
      'packages/core/src/router/index.ts': {
        lines: { total: 100, covered: 95 },
        functions: { total: 10, covered: 9 },
        branches: { total: 8, covered: 7 },
        statements: { total: 100, covered: 95 },
      },
      'packages/core/src/router/index.test.ts': {
        lines: { total: 100, covered: 100 },
        functions: { total: 10, covered: 10 },
        branches: { total: 8, covered: 8 },
        statements: { total: 100, covered: 100 },
      },
      'packages/core/src/router/view.tsx': {
        lines: { total: 100, covered: 90 },
        functions: { total: 10, covered: 8 },
        branches: { total: 4, covered: 2 },
        statements: { total: 100, covered: 90 },
      },
      'packages/cli/src/index.ts': {
        lines: { total: 100, covered: 50 },
        functions: { total: 10, covered: 5 },
        branches: { total: 4, covered: 1 },
        statements: { total: 100, covered: 50 },
      },
    });

    expect(parseCoverageSummaryScopes(json, ['global', 'packages/core/src/**/*.{ts,tsx}'])).toEqual({
      global: { lines: 90, functions: 80, branches: 50, statements: 90 },
      'packages/core/src/**/*.{ts,tsx}': {
        lines: 95,
        functions: 90,
        branches: 85,
        statements: 95,
      },
    });
  });

  it('matches absolute coverage-summary paths against repo-relative threshold globs', () => {
    const json = JSON.stringify({
      total: {
        lines: { total: 100, covered: 95, pct: 95 },
        functions: { total: 10, covered: 9, pct: 90 },
        branches: { total: 8, covered: 7, pct: 87.5 },
        statements: { total: 100, covered: 95, pct: 95 },
      },
      '/repo/software-factory/packages/config/src/index.ts': {
        lines: { total: 100, covered: 95 },
        functions: { total: 10, covered: 9 },
        branches: { total: 8, covered: 7 },
        statements: { total: 100, covered: 95 },
      },
    });

    expect(parseCoverageSummaryScopes(json, ['packages/config/src/**/*.{ts,tsx}'])).toEqual({
      'packages/config/src/**/*.{ts,tsx}': {
        lines: 95,
        functions: 90,
        branches: 87.5,
        statements: 95,
      },
    });
  });

  it('throws when a scoped threshold has no matching files', () => {
    const json = summaryJson({
      lines: { total: 100, covered: 95, pct: 95 },
      functions: { total: 10, covered: 9, pct: 90 },
      branches: { total: 8, covered: 7, pct: 87.5 },
      statements: { total: 100, covered: 95, pct: 95 },
    });

    expect(() => parseCoverageSummaryScopes(json, ['packages/missing/src/**/*.{ts,tsx}']))
      .toThrow(/no files/);
  });
});

describe('checkRatchetDrift', () => {
  const thresholds: CoverageMetrics = { lines: 90, functions: 90, branches: 85, statements: 90 };

  it('reports ok when all gaps are within slack', () => {
    const measured: CoverageMetrics = { lines: 91, functions: 92, branches: 86, statements: 90 };
    expect(checkRatchetDrift(measured, thresholds)).toEqual({ ok: true, drifts: [] });
  });

  it('does not flag a gap exactly equal to the slack (boundary)', () => {
    const measured: CoverageMetrics = { lines: 92, functions: 90, branches: 85, statements: 90 };
    expect(checkRatchetDrift(measured, thresholds, 2)).toEqual({ ok: true, drifts: [] });
  });

  it('flags a single metric over slack with the correct suggestion', () => {
    const measured: CoverageMetrics = { lines: 95, functions: 90, branches: 85, statements: 90 };
    const result = checkRatchetDrift(measured, thresholds, 2);
    expect(result.ok).toBe(false);
    expect(result.drifts).toEqual([
      { metric: 'lines', measured: 95, threshold: 90, suggested: 94 },
    ]);
  });

  it('flags multiple metrics over slack', () => {
    const measured: CoverageMetrics = { lines: 95, functions: 96, branches: 85, statements: 90 };
    const result = checkRatchetDrift(measured, thresholds, 2);
    expect(result.ok).toBe(false);
    expect(result.drifts.map(d => d.metric)).toEqual(['lines', 'functions']);
  });

  it('respects a custom slack', () => {
    const measured: CoverageMetrics = { lines: 93, functions: 90, branches: 85, statements: 90 };
    expect(checkRatchetDrift(measured, thresholds, 5).ok).toBe(true);
    expect(checkRatchetDrift(measured, thresholds, 1).ok).toBe(false);
  });

  it('defaults to DEFAULT_RATCHET_SLACK when slack is omitted', () => {
    expect(DEFAULT_RATCHET_SLACK).toBe(2);
    const measured: CoverageMetrics = { lines: 92, functions: 90, branches: 85, statements: 90 };
    expect(checkRatchetDrift(measured, thresholds).ok).toBe(true);
    const drifting: CoverageMetrics = { lines: 93, functions: 90, branches: 85, statements: 90 };
    expect(checkRatchetDrift(drifting, thresholds).ok).toBe(false);
  });

  it('handles fractional measured values', () => {
    const result = checkRatchetDrift(
      { lines: 90, functions: 90, branches: 88.42, statements: 90 },
      { lines: 90, functions: 90, branches: 85, statements: 90 },
      2,
    );
    expect(result.drifts).toEqual([
      { metric: 'branches', measured: 88.42, threshold: 85, suggested: 87 },
    ]);
  });
});

describe('checkScopedRatchetDrift', () => {
  it('reports package-scoped drifts with their scope labels', () => {
    const result = checkScopedRatchetDrift(
      {
        global: { lines: 95, functions: 92, branches: 86, statements: 95 },
        'packages/core/src/**/*.{ts,tsx}': { lines: 98, functions: 96, branches: 88, statements: 98 },
      },
      {
        global: { lines: 94, functions: 91, branches: 85, statements: 94 },
        'packages/core/src/**/*.{ts,tsx}': { lines: 94, functions: 94, branches: 85, statements: 94 },
      },
      2,
    );

    expect(result).toEqual({
      ok: false,
      drifts: [
        { scope: 'packages/core/src/**/*.{ts,tsx}', metric: 'lines', measured: 98, threshold: 94, suggested: 97 },
        { scope: 'packages/core/src/**/*.{ts,tsx}', metric: 'branches', measured: 88, threshold: 85, suggested: 87 },
        { scope: 'packages/core/src/**/*.{ts,tsx}', metric: 'statements', measured: 98, threshold: 94, suggested: 97 },
      ],
    });
  });
});

describe('renderRatchetReport', () => {
  it('renders a single OK line mentioning the slack', () => {
    const report = renderRatchetReport({ ok: true, drifts: [] }, 2);
    expect(report).toMatch(/^Coverage ratchet OK/);
    expect(report).toContain('2pts');
  });

  it('renders a drift table with metric names, values, and the raise-thresholds instruction', () => {
    const result: RatchetCheckResult = {
      ok: false,
      drifts: [
        { metric: 'lines', measured: 95, threshold: 90, suggested: 94 },
        { metric: 'branches', measured: 88.42, threshold: 85, suggested: 87 },
      ],
    };
    const report = renderRatchetReport(result, 2);

    expect(report).toContain('lines');
    expect(report).toContain('95');
    expect(report).toContain('90');
    expect(report).toContain('94');
    expect(report).toContain('branches');
    expect(report).toContain('88.42');
    expect(report).toContain('87');
    expect(report).toContain('thresholds');
    expect(report).toContain('vitest.config.ts');
  });

  it('renders scoped drifts with scope labels', () => {
    const report = renderRatchetReport({
      ok: false,
      drifts: [
        { scope: 'packages/core/src/**/*.{ts,tsx}', metric: 'lines', measured: 98, threshold: 94, suggested: 97 },
      ],
    }, 2);

    expect(report).toContain('Scope');
    expect(report).toContain('packages/core/src/**/*.{ts,tsx}');
  });
});
