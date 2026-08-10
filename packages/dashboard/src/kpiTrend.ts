// src/kpiTrend.ts — shapes KpiHistoryRecord[] into per-metric time series for the trend view.
//
// This is a browser bundle: @on-par/factory-core's runtime (router/harness/checkers) pulls in
// Node-only deps (execa, @octokit/rest) that don't resolve for a client build, so only the
// KpiHistoryRecord *type* is imported from it. parseKpiHistory and the rolling drift-window
// check below are faithful, pure ports of the same-named logic in
// packages/core/src/kpis/index.ts (#612, #613, #614) — no new KPI computation is introduced,
// this just makes the existing derivation runnable client-side.

import type { KpiHistoryRecord } from '@on-par/factory-core';

export interface TrendPoint {
  date: string;
  value: number | null;
}

export function parseKpiHistory(jsonl: string): KpiHistoryRecord[] {
  return jsonl
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as KpiHistoryRecord);
}

const KPI_DRIFT_WINDOW_SIZE = 20;
const KPI_DRIFT_THRESHOLD_RATIO = 0.25;

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function numericValues(values: (number | null | undefined)[]): number[] {
  return values.filter((v): v is number => typeof v === 'number');
}

function driftDetected(baselineValues: number[], recentValues: number[]): boolean {
  const baseline = mean(baselineValues);
  const recent = mean(recentValues);
  if (baseline === null || recent === null) return false;
  if (baseline === 0) return recent > 0;
  return (recent - baseline) / baseline > KPI_DRIFT_THRESHOLD_RATIO;
}

/** Whether the rolling window (reworkRate, costPerMergedPr, medianCycleTimeMs) is ready
 *  and flags drift, using only history up to and including `records[records.length - 1]`. */
function isDriftFlagged(records: KpiHistoryRecord[]): { ready: boolean; drift: boolean } {
  if (records.length < KPI_DRIFT_WINDOW_SIZE * 2) return { ready: false, drift: false };
  const recentWindow = records.slice(records.length - KPI_DRIFT_WINDOW_SIZE);
  const baselineWindow = records.slice(
    records.length - KPI_DRIFT_WINDOW_SIZE * 2,
    records.length - KPI_DRIFT_WINDOW_SIZE,
  );

  const drift =
    driftDetected(
      numericValues(baselineWindow.map((r) => r.reworkRate)),
      numericValues(recentWindow.map((r) => r.reworkRate)),
    ) ||
    driftDetected(
      numericValues(baselineWindow.map((r) => r.costPerMergedPr)),
      numericValues(recentWindow.map((r) => r.costPerMergedPr)),
    ) ||
    driftDetected(
      numericValues(baselineWindow.map((r) => r.medianCycleTimeMs)),
      numericValues(recentWindow.map((r) => r.medianCycleTimeMs)),
    );

  return { ready: true, drift };
}

export function buildDefectRateSeries(records: KpiHistoryRecord[]): TrendPoint[] {
  return records.map((record) => ({ date: record.date, value: record.postMergeDefectRate ?? null }));
}

/** One point per snapshot: whether the rolling drift window flagged drift using only the
 *  history up to that snapshot. Null until enough history has accumulated to be ready. */
export function buildDriftFlagSeries(records: KpiHistoryRecord[]): TrendPoint[] {
  return records.map((record, index) => {
    const { ready, drift } = isDriftFlagged(records.slice(0, index + 1));
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
