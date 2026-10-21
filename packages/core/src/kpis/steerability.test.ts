import { describe, expect, it } from 'vitest';

import type { IssueRunState } from '../types/index.js';
import type { ClassifierOutcomeRecord } from './classifier-outcomes.js';
import {
  collectMergedPrSteers,
  formatSteerabilityReport,
  isoWeekKey,
  summarizeSteerability,
  type MergedPrSteers,
} from './steerability.js';

const row = (prNumber: number, lane: string, mergedAt: string, steers: number): MergedPrSteers => ({
  issue: prNumber,
  prNumber,
  lane,
  mergedAt,
  steers,
});

const steer = (ts: string) => ({ ts, actor: 'a', source: 'cli' as const, phase: 'build' as const, summary: 's' });
const run = (issue: number, extra: Partial<IssueRunState> = {}) => ({ issue, ...extra }) as IssueRunState;
const outcome = (issue: number, prNumber: number, o: Partial<ClassifierOutcomeRecord> = {}) =>
  ({
    issue: String(issue),
    prNumber,
    merged: true,
    mergedAt: '2026-08-04T00:00:00.000Z',
    ...o,
  }) as ClassifierOutcomeRecord;

describe('isoWeekKey', () => {
  it('handles year-boundary edges', () => {
    expect(isoWeekKey('2026-01-01T00:00:00Z')).toBe('2026-W01');
    expect(isoWeekKey('2027-01-01T00:00:00Z')).toBe('2026-W53');
    expect(isoWeekKey('2024-12-30T00:00:00Z')).toBe('2025-W01');
  });
  it('returns null for an invalid string', () => {
    expect(isoWeekKey('nope')).toBeNull();
  });
});

describe('summarizeSteerability', () => {
  it('groups merged PRs by lane and ISO week with min/median/max/histogram', () => {
    const report = summarizeSteerability([
      row(1, 'small', '2026-08-03T00:00:00Z', 0),
      row(2, 'small', '2026-08-04T00:00:00Z', 1),
      row(3, 'small', '2026-08-11T00:00:00Z', 3),
      row(4, 'large', '2026-08-11T00:00:00Z', 2),
    ]);
    const small = report.byLane.find((b) => b.key === 'small');
    expect(small).toMatchObject({ mergedPrs: 3, steers: 4 });
    expect(small?.steersPerMergedPr).toBeCloseTo(4 / 3);
    expect(small?.distribution).toEqual({ min: 0, median: 1, max: 3, histogram: { '0': 1, '1': 1, '2': 0, '3': 1 } });
    expect(report.byLane.map((b) => b.key)).toEqual(['large', 'small']);
    expect(report.byWeek.map((b) => b.key)).toEqual(['2026-W32', '2026-W33']);
    expect(report.byWeek[1].distribution?.median).toBe(2.5);
    expect(report.total).toMatchObject({ key: 'all', mergedPrs: 4, steers: 6, steersPerMergedPr: 1.5 });
  });

  it('is safe for empty input', () => {
    const report = summarizeSteerability([]);
    expect(report.total).toMatchObject({ mergedPrs: 0, steersPerMergedPr: null, distribution: null });
    expect(report.byLane).toEqual([]);
    expect(report.byWeek).toEqual([]);
  });
});

describe('collectMergedPrSteers', () => {
  it('ignores unmerged records and counts duplicate PRs once', () => {
    const { rows } = collectMergedPrSteers(
      [run(1, { lane: 'small', steers: [steer('2026-08-03T00:00:00Z')] })],
      [outcome(1, 10, { merged: false }), outcome(1, 11), outcome(1, 11)],
    );
    expect(rows).toEqual([{ issue: 1, prNumber: 11, lane: 'small', mergedAt: '2026-08-04T00:00:00.000Z', steers: 1 }]);
  });

  it('splits steers across slice PRs by merge window', () => {
    const { rows } = collectMergedPrSteers(
      [run(1, { steers: [steer('2026-08-01T00:00:00Z'), steer('2026-08-05T00:00:00Z'), steer('bad')] })],
      [outcome(1, 20, { mergedAt: '2026-08-10T00:00:00Z' }), outcome(1, 21, { mergedAt: '2026-08-04T00:00:00Z' })],
    );
    expect(rows.map((r) => [r.prNumber, r.steers])).toEqual([
      [21, 1],
      [20, 1],
    ]);
  });

  it('counts unmatched records and defaults lane and steers', () => {
    const { rows, unmatched } = collectMergedPrSteers(
      [run(1)],
      [outcome(1, 1), outcome(2, 2), outcome(1, 3, { mergedAt: 'garbage' })],
    );
    expect(unmatched).toBe(2);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ lane: 'unknown', steers: 0 });
  });
});

describe('formatSteerabilityReport', () => {
  it('reports the empty case', () => {
    expect(formatSteerabilityReport(summarizeSteerability([]))).toEqual([
      'Steerability (steers per merged PR):',
      'No merged PRs with run state yet.',
    ]);
  });

  it('formats buckets, histograms and skipped PRs', () => {
    const lines = formatSteerabilityReport(
      summarizeSteerability(
        [row(1, 'small', '2026-08-03T00:00:00Z', 1), row(2, 'small', '2026-08-04T00:00:00Z', 0)],
        2,
      ),
    );
    expect(lines).toContain('By lane:');
    expect(lines).toContain('By week:');
    expect(
      lines.some((l) => l.includes('small') && l.includes('2 PRs, 1 steers, 0.5 per PR, min 0 / median 0.5 / max 1')),
    ).toBe(true);
    expect(lines).toContain('  histogram 0:1 1:1');
    expect(lines.at(-1)).toBe('2 merged PR(s) had no run state and were skipped');
  });
});
