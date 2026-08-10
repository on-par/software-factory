import type { KpiHistoryRecord } from '@on-par/factory-core';
import { KPI_DRIFT_WINDOW_SIZE } from '@on-par/factory-core/kpis';
import { describe, expect, it } from 'vitest';

import {
  buildDefectRateSeries,
  buildDriftFlagSeries,
  buildPhaseBreakdownSeries,
  buildReworkSplitSeries,
} from './kpiTrend.js';

function record(overrides: Partial<KpiHistoryRecord> = {}): KpiHistoryRecord {
  return {
    date: '2026-01-01',
    runs: 10,
    mergeRate: 0.9,
    reworkRate: 0.2,
    stuckRate: 0.01,
    humanInterventionRate: 0.1,
    fullyAutonomousRate: 0.8,
    costPerMergedPr: 5,
    medianCycleTimeMs: 600_000,
    p90CycleTimeMs: 900_000,
    ...overrides,
  };
}

describe('buildDefectRateSeries', () => {
  it('maps postMergeDefectRate per record', () => {
    const records = [
      record({ date: 'r1', postMergeDefectRate: 0.1 }),
      record({ date: 'r2', postMergeDefectRate: 0.2 }),
    ];
    expect(buildDefectRateSeries(records)).toEqual([
      { date: 'r1', value: 0.1 },
      { date: 'r2', value: 0.2 },
    ]);
  });

  it('reports null for legacy rows missing postMergeDefectRate', () => {
    expect(buildDefectRateSeries([record({ date: 'r1' })])).toEqual([{ date: 'r1', value: null }]);
  });
});

describe('buildDriftFlagSeries', () => {
  it('is null until enough history has accumulated for a rolling window', () => {
    const records = Array.from({ length: KPI_DRIFT_WINDOW_SIZE }, (_, i) => record({ date: `r${i}` }));
    const series = buildDriftFlagSeries(records);
    expect(series.every((point) => point.value === null)).toBe(true);
  });

  it('flags 0/1 once the rolling window is ready', () => {
    const records = Array.from({ length: KPI_DRIFT_WINDOW_SIZE * 2 }, (_, i) => record({ date: `r${i}` }));
    const series = buildDriftFlagSeries(records);
    const readyPoints = series.slice(KPI_DRIFT_WINDOW_SIZE * 2 - 1);
    expect(readyPoints.every((point) => point.value === 0 || point.value === 1)).toBe(true);
  });

  it('flags drift once the recent window is worse than the baseline', () => {
    const stable = Array.from({ length: KPI_DRIFT_WINDOW_SIZE }, (_, i) =>
      record({ date: `stable${i}`, reworkRate: 0.1 }),
    );
    const worse = Array.from({ length: KPI_DRIFT_WINDOW_SIZE }, (_, i) =>
      record({ date: `worse${i}`, reworkRate: 0.9 }),
    );
    const series = buildDriftFlagSeries([...stable, ...worse]);
    expect(series[series.length - 1].value).toBe(1);
  });

  it('flags drift when a zero baseline becomes non-zero', () => {
    const baseline = Array.from({ length: KPI_DRIFT_WINDOW_SIZE }, (_, i) => record({ date: `b${i}`, reworkRate: 0 }));
    const recent = Array.from({ length: KPI_DRIFT_WINDOW_SIZE }, (_, i) => record({ date: `r${i}`, reworkRate: 0.5 }));
    const series = buildDriftFlagSeries([...baseline, ...recent]);
    expect(series[series.length - 1].value).toBe(1);
  });

  it('does not flag drift when a zero baseline stays zero', () => {
    const records = Array.from({ length: KPI_DRIFT_WINDOW_SIZE * 2 }, (_, i) =>
      record({ date: `r${i}`, reworkRate: 0 }),
    );
    const series = buildDriftFlagSeries(records);
    expect(series[series.length - 1].value).toBe(0);
  });

  it('treats a metric missing across a whole window as no signal, not a crash', () => {
    // costPerMergedPr is null throughout the baseline half (baseline mean unavailable);
    // medianCycleTimeMs is null throughout the recent half (recent mean unavailable).
    // reworkRate stays constant so it contributes no drift either.
    const baseline = Array.from({ length: KPI_DRIFT_WINDOW_SIZE }, (_, i) =>
      record({ date: `b${i}`, costPerMergedPr: null }),
    );
    const recent = Array.from({ length: KPI_DRIFT_WINDOW_SIZE }, (_, i) =>
      record({ date: `r${i}`, medianCycleTimeMs: null }),
    );
    const series = buildDriftFlagSeries([...baseline, ...recent]);
    expect(series[series.length - 1].value).toBe(0);
  });
});

describe('buildPhaseBreakdownSeries', () => {
  it('returns one entry per observed phase, sorted', () => {
    const records = [
      record({ date: 'r1', phaseDurationsMs: { build: 5000, plan: 1000 }, phaseCosts: { build: 0.05 } }),
      record({ date: 'r2', phaseDurationsMs: { check: 2000 } }),
    ];
    const series = buildPhaseBreakdownSeries(records);
    expect(series.map((p) => p.phase)).toEqual(['build', 'check', 'plan']);

    const build = series.find((p) => p.phase === 'build')!;
    expect(build.durationMs).toEqual([
      { date: 'r1', value: 5000 },
      { date: 'r2', value: null },
    ]);
    expect(build.cost).toEqual([
      { date: 'r1', value: 0.05 },
      { date: 'r2', value: null },
    ]);
  });

  it('returns no phases when no record carries phase data', () => {
    expect(buildPhaseBreakdownSeries([record()])).toEqual([]);
  });
});

describe('buildReworkSplitSeries', () => {
  it('splits reworkRate into collision-caused and the remainder', () => {
    const records = [record({ date: 'r1', reworkRate: 0.3, collisionReworkRate: 0.1 })];
    const split = buildReworkSplitSeries(records);
    expect(split.collision).toEqual([{ date: 'r1', value: 0.1 }]);
    expect(split.checker[0].date).toBe('r1');
    expect(split.checker[0].value).toBeCloseTo(0.2);
  });

  it('is null for both series on legacy rows missing collisionReworkRate', () => {
    const records = [record({ date: 'r1', reworkRate: 0.3 })];
    expect(buildReworkSplitSeries(records)).toEqual({
      collision: [{ date: 'r1', value: null }],
      checker: [{ date: 'r1', value: null }],
    });
  });

  it('clamps the checker remainder at zero', () => {
    const records = [record({ date: 'r1', reworkRate: 0.1, collisionReworkRate: 0.3 })];
    expect(buildReworkSplitSeries(records).checker).toEqual([{ date: 'r1', value: 0 }]);
  });
});
