// src/kpiTrend.ts — shapes KpiHistoryRecord[] into per-metric time series for the trend view.
//
// This is a browser bundle: @on-par/factory-core's root runtime (router/harness/checkers)
// pulls in Node-only deps (execa, @octokit/rest) that don't resolve for a client build. The
// ./kpis subpath (mirroring the existing ./internal and ./testing pattern) re-exports only
// the pure packages/core/src/kpis/index.ts module, so parseKpiHistory and computeKpiDrift
// can be imported and run for real here instead of being re-implemented client-side.

import { computeKpiDrift, parseKpiHistory } from '@on-par/factory-core/kpis';
import type { KpiHistoryRecord } from '@on-par/factory-core';

export { parseKpiHistory };

export interface TrendPoint {
  date: string;
  value: number | null;
}

export function buildDefectRateSeries(records: KpiHistoryRecord[]): TrendPoint[] {
  return records.map((record) => ({ date: record.date, value: record.postMergeDefectRate ?? null }));
}

/** One point per snapshot: whether the rolling drift window flagged drift using only the
 *  history up to that snapshot. Null until enough history has accumulated to be ready. */
export function buildDriftFlagSeries(records: KpiHistoryRecord[]): TrendPoint[] {
  return records.map((record, index) => {
    const { ready, drift } = computeKpiDrift(records.slice(0, index + 1));
    return { date: record.date, value: ready ? (drift ? 1 : 0) : null };
  });
}

export interface PhaseSeries {
  phase: string;
  durationMs: TrendPoint[];
  cost: TrendPoint[];
}

export function buildPhaseBreakdownSeries(records: KpiHistoryRecord[]): PhaseSeries[] {
  const phases = new Set<string>();
  for (const record of records) {
    for (const phase of Object.keys(record.phaseDurationsMs ?? {})) phases.add(phase);
    for (const phase of Object.keys(record.phaseCosts ?? {})) phases.add(phase);
  }
  return [...phases].sort().map((phase) => ({
    phase,
    durationMs: records.map((record) => ({ date: record.date, value: record.phaseDurationsMs?.[phase] ?? null })),
    cost: records.map((record) => ({ date: record.date, value: record.phaseCosts?.[phase] ?? null })),
  }));
}

export interface ReworkSplitSeries {
  collision: TrendPoint[];
  checker: TrendPoint[];
}

/** Splits rework into collision-caused (#615's collisionReworkRate) vs the remainder,
 *  attributed to checker failures since reworkRate counts every rework-triggering run. */
export function buildReworkSplitSeries(records: KpiHistoryRecord[]): ReworkSplitSeries {
  return {
    collision: records.map((record) => ({ date: record.date, value: record.collisionReworkRate ?? null })),
    checker: records.map((record) => ({
      date: record.date,
      value:
        typeof record.collisionReworkRate === 'number'
          ? Math.max(0, record.reworkRate - record.collisionReworkRate)
          : null,
    })),
  };
}
