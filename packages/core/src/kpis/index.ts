// src/kpis/index.ts — Pure aggregation of factory health KPIs from events + cost rows

import type { CostEntry, FactoryEvent, RetryCause } from '../types/index.js';
import { isHumanEvent } from './human.js';

export type { CommitSource, HumanSourceClient, PrSource } from './human.js';
export {
  fetchHumanEventSources,
  hasUnresolvedPark,
  HUMAN_EVENT_TYPES,
  isHumanEvent,
  reconstructHumanEvents,
} from './human.js';

function isRealIssue(issue: string): boolean {
  return /^\d+$/.test(issue);
}

const PHASE_ORDER = ['plan', 'build', 'check', 'ship'];

function percentileFromSorted(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function percentile(values: number[], p: number): number | null {
  return percentileFromSorted(
    [...values].sort((a, b) => a - b),
    p,
  );
}

function formatDurationMs(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export interface HealthKpis {
  runs: number;
  merged: number;
  /** Runs that entered the rework loop at least once (breadth: run-level boolean —
   *  did it loop at all). See totalRetries/retriesByCause for depth + cause. */
  reworkRuns: number;
  stuckRuns: number;
  mergeRate: number;
  /** Share of runs that looped at all (breadth). Distinct from retries, which
   *  count how many times and why — both are kept intentionally. */
  reworkRate: number;
  stuckRate: number;
  /** Share of runs with at least one explicit human-* event (#420). */
  humanInterventionRate: number;
  /** Runs with at least one explicit human-* event (#420). */
  humanTouchedRuns: number;
  /** Runs that merged with zero human events — the demo headline (#420). */
  fullyAutonomousRuns: number;
  /** Mean human events per run; null when runs === 0. */
  humanEventsPerRun: number | null;
  /** fullyAutonomousRuns / runs; 0 when runs === 0. */
  fullyAutonomousRate: number;
  totalCost: number;
  costPerMergedPr: number | null;
  medianCycleTimeMs: number | null;
  p90CycleTimeMs: number | null;
  phaseDurations: Record<string, number>;
  queueWaitMs: number | null;
  cycleTimeExcludedRuns: number;
  /** Total retry attempts across all runs, from retryCauseOf() over events. */
  totalRetries: number;
  /** Median retries per run (all runs, including zero-retry runs); null when runs === 0. */
  retriesPerRun: number | null;
  /** Retry counts per cause bucket; all four keys always present. */
  retriesByCause: Record<RetryCause, number>;
  /** Fraction of totalCost from CostEntry rows tied to retry attempts
   *  (rows with retryCause set or failoverReason set); 0 when totalCost is 0. */
  retryCostShare: number;
}

interface RunStats {
  merged: boolean;
  reworked: boolean;
  stuck: boolean;
  humanEvents: number;
  firstTs: number | null;
  mergedTs: number | null;
  firstPhaseTs: number | null;
  phaseWindows: Map<string, { first: number; last: number }>;
  retries: number;
}

/** Attribute one event to a retry-cause bucket, or null if it is not a retry.
 *  'rework' events are one checker retry per round; 'stuck' events repeat the
 *  same round's payload and must NOT count. Any event carrying failoverReason
 *  is a failover retry attempt, split out by timeout / unknown. */
export function retryCauseOf(event: FactoryEvent): RetryCause | null {
  if (event.type === 'rework') return 'checker';
  if (event.failoverReason === 'timeout') return 'timeout';
  if (event.failoverReason === 'unknown') return 'other';
  if (event.failoverReason) return 'failover';
  return null;
}

export function computeHealthKpis(events: FactoryEvent[], costs: CostEntry[]): HealthKpis {
  const runsByIssue = new Map<string, RunStats>();
  const retriesByCause: Record<RetryCause, number> = { checker: 0, failover: 0, timeout: 0, other: 0 };

  for (const event of events) {
    if (!isRealIssue(event.issue)) continue;

    const stats = runsByIssue.get(event.issue) ?? {
      merged: false,
      reworked: false,
      stuck: false,
      humanEvents: 0,
      firstTs: null,
      mergedTs: null,
      firstPhaseTs: null,
      phaseWindows: new Map<string, { first: number; last: number }>(),
      retries: 0,
    };

    if (event.type === 'merged' || event.type === 'human-merged') stats.merged = true;
    if (event.type === 'rework' || event.rework) stats.reworked = true;
    if (event.type === 'stuck' || event.rework?.stuck === true) stats.stuck = true;
    if (isHumanEvent(event)) stats.humanEvents++;

    const retryCause = retryCauseOf(event);
    if (retryCause) {
      stats.retries++;
      retriesByCause[retryCause]++;
    }

    const ts = Date.parse(event.ts);
    if (!Number.isNaN(ts)) {
      if (stats.firstTs === null || ts < stats.firstTs) stats.firstTs = ts;
      if ((event.type === 'merged' || event.type === 'human-merged') && stats.mergedTs === null) stats.mergedTs = ts;
      if (event.phase) {
        if (stats.firstPhaseTs === null || ts < stats.firstPhaseTs) stats.firstPhaseTs = ts;
        const window = stats.phaseWindows.get(event.phase);
        if (!window) {
          stats.phaseWindows.set(event.phase, { first: ts, last: ts });
        } else {
          if (ts < window.first) window.first = ts;
          if (ts > window.last) window.last = ts;
        }
      }
    }

    runsByIssue.set(event.issue, stats);
  }

  const runs = runsByIssue.size;
  let merged = 0;
  let reworkRuns = 0;
  let stuckRuns = 0;
  let humanTouchedRuns = 0;
  let fullyAutonomousRuns = 0;
  let totalHumanEvents = 0;
  const cycleTimes: number[] = [];
  const queueWaits: number[] = [];
  const phaseSamples = new Map<string, number[]>();
  const perRunRetryCounts: number[] = [];

  for (const stats of runsByIssue.values()) {
    if (stats.merged) merged++;
    if (stats.reworked) reworkRuns++;
    if (stats.stuck) stuckRuns++;
    if (stats.humanEvents > 0) humanTouchedRuns++;
    if (stats.merged && stats.humanEvents === 0) fullyAutonomousRuns++;
    totalHumanEvents += stats.humanEvents;
    perRunRetryCounts.push(stats.retries);

    if (stats.firstTs !== null && stats.mergedTs !== null) {
      cycleTimes.push(Math.max(0, stats.mergedTs - stats.firstTs));
    }
    if (stats.firstTs !== null && stats.firstPhaseTs !== null) {
      queueWaits.push(Math.max(0, stats.firstPhaseTs - stats.firstTs));
    }
    for (const [phase, window] of stats.phaseWindows) {
      const samples = phaseSamples.get(phase) ?? [];
      samples.push(Math.max(0, window.last - window.first));
      phaseSamples.set(phase, samples);
    }
  }

  const totalCost = costs.reduce((sum, entry) => sum + (entry.cost ?? 0), 0);
  const retryCost = costs.reduce(
    (sum, entry) => sum + (entry.retryCause || entry.failoverReason ? (entry.cost ?? 0) : 0),
    0,
  );
  const totalRetries = retriesByCause.checker + retriesByCause.failover + retriesByCause.timeout + retriesByCause.other;
  const sortedCycleTimes = [...cycleTimes].sort((a, b) => a - b);

  const observedPhases = [...phaseSamples.keys()];
  const orderedPhases = [
    ...PHASE_ORDER.filter((phase) => phaseSamples.has(phase)),
    ...observedPhases.filter((phase) => !PHASE_ORDER.includes(phase)).sort(),
  ];
  const phaseDurations: Record<string, number> = {};
  for (const phase of orderedPhases) {
    phaseDurations[phase] = percentile(phaseSamples.get(phase)!, 0.5)!;
  }

  return {
    runs,
    merged,
    reworkRuns,
    stuckRuns,
    mergeRate: runs === 0 ? 0 : merged / runs,
    reworkRate: runs === 0 ? 0 : reworkRuns / runs,
    stuckRate: runs === 0 ? 0 : stuckRuns / runs,
    humanInterventionRate: runs === 0 ? 0 : humanTouchedRuns / runs,
    humanTouchedRuns,
    fullyAutonomousRuns,
    humanEventsPerRun: runs === 0 ? null : totalHumanEvents / runs,
    fullyAutonomousRate: runs === 0 ? 0 : fullyAutonomousRuns / runs,
    totalCost,
    costPerMergedPr: merged === 0 ? null : totalCost / merged,
    medianCycleTimeMs: percentileFromSorted(sortedCycleTimes, 0.5),
    p90CycleTimeMs: percentileFromSorted(sortedCycleTimes, 0.9),
    phaseDurations,
    queueWaitMs: percentile(queueWaits, 0.5),
    cycleTimeExcludedRuns: runs - cycleTimes.length,
    totalRetries,
    retriesPerRun: runs === 0 ? null : percentile(perRunRetryCounts, 0.5),
    retriesByCause,
    retryCostShare: totalCost === 0 ? 0 : retryCost / totalCost,
  };
}

function formatPercent(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

function formatCost(value: number): string {
  return `$${value.toFixed(4)}`;
}

export function formatKpiLines(kpis: HealthKpis): string[] {
  if (kpis.runs === 0) return ['No factory runs recorded yet.'];

  const lines = [
    `Runs: ${kpis.runs}`,
    `Merge rate: ${formatPercent(kpis.mergeRate)} (${kpis.merged}/${kpis.runs})`,
    `Rework rate: ${formatPercent(kpis.reworkRate)} (${kpis.reworkRuns}/${kpis.runs})`,
    `Stuck rate: ${formatPercent(kpis.stuckRate)} (${kpis.stuckRuns}/${kpis.runs})`,
    `Human-touched runs: ${formatPercent(kpis.humanInterventionRate)} (${kpis.humanTouchedRuns}/${kpis.runs}, ${kpis.humanEventsPerRun === null ? 'n/a' : kpis.humanEventsPerRun.toFixed(2)} human events/run)`,
    `Fully autonomous: ${formatPercent(kpis.fullyAutonomousRate)} (${kpis.fullyAutonomousRuns}/${kpis.runs} merged with zero human events)`,
    `Retries: total ${kpis.totalRetries}, median ${kpis.retriesPerRun}/run (checker ${kpis.retriesByCause.checker} · failover ${kpis.retriesByCause.failover} · timeout ${kpis.retriesByCause.timeout} · other ${kpis.retriesByCause.other})`,
    `Retry cost share: ${formatPercent(kpis.retryCostShare)} of total spend`,
    `Cost per merged PR: ${kpis.costPerMergedPr === null ? 'n/a' : formatCost(kpis.costPerMergedPr)}`,
  ];

  lines.push(
    kpis.medianCycleTimeMs === null
      ? `Cycle time (issue→merge): n/a (${kpis.cycleTimeExcludedRuns} excluded: no terminal event)`
      : `Cycle time (issue→merge): median ${formatDurationMs(kpis.medianCycleTimeMs)}, p90 ${formatDurationMs(kpis.p90CycleTimeMs!)} (${kpis.merged} merged, ${kpis.cycleTimeExcludedRuns} excluded: no terminal event)`,
  );
  const phaseEntries = Object.entries(kpis.phaseDurations);
  if (phaseEntries.length > 0) {
    lines.push(`Phase medians: ${phaseEntries.map(([p, ms]) => `${p} ${formatDurationMs(ms)}`).join(' · ')}`);
  }
  lines.push(`Queue wait (median): ${kpis.queueWaitMs === null ? 'n/a' : formatDurationMs(kpis.queueWaitMs)}`);

  return lines;
}

export function renderKpiReport(kpis: HealthKpis): string {
  const lines = ['## Health KPIs', '', ...formatKpiLines(kpis).map((line) => `- ${line}`)];
  return `${lines.join('\n')}\n`;
}

export interface KpiHistoryRecord {
  date: string;
  runs: number;
  mergeRate: number;
  reworkRate: number;
  stuckRate: number;
  humanInterventionRate: number;
  fullyAutonomousRate: number;
  costPerMergedPr: number | null;
  medianCycleTimeMs: number | null;
  p90CycleTimeMs: number | null;
  /** HEAD commit SHA at snapshot time; null when the git lookup failed. Absent in legacy rows. */
  commitSha?: string | null;
  /** Resolved tier → ranked model list at snapshot time. Absent in legacy rows. */
  models?: Record<string, string[]>;
}

export function kpisToHistoryRecord(
  kpis: HealthKpis,
  date: string,
  meta: { commitSha?: string | null; models?: Record<string, string[]> } = {},
): KpiHistoryRecord {
  return {
    date,
    runs: kpis.runs,
    mergeRate: kpis.mergeRate,
    reworkRate: kpis.reworkRate,
    stuckRate: kpis.stuckRate,
    humanInterventionRate: kpis.humanInterventionRate,
    fullyAutonomousRate: kpis.fullyAutonomousRate,
    costPerMergedPr: kpis.costPerMergedPr,
    medianCycleTimeMs: kpis.medianCycleTimeMs,
    p90CycleTimeMs: kpis.p90CycleTimeMs,
    ...(meta.commitSha !== undefined ? { commitSha: meta.commitSha } : {}),
    ...(meta.models !== undefined ? { models: meta.models } : {}),
  };
}

export function parseKpiHistory(jsonl: string): KpiHistoryRecord[] {
  return jsonl
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as KpiHistoryRecord);
}

export function appendKpiHistoryLine(existing: string, record: KpiHistoryRecord): string {
  const line = `${JSON.stringify(record)}\n`;
  if (!existing.trim()) return line;
  return `${existing.endsWith('\n') ? existing : `${existing}\n`}${line}`;
}

function formatSignedPp(curr: number | undefined, prev: number | undefined): string {
  if (typeof curr !== 'number' || typeof prev !== 'number') return '—';
  const delta = Math.round((curr - prev) * 100);
  if (delta === 0) return '0pp';
  return `${delta > 0 ? '+' : '−'}${Math.abs(delta)}pp`;
}

function formatSignedInt(curr: number, prev: number): string {
  const delta = curr - prev;
  if (delta === 0) return '0';
  return `${delta > 0 ? '+' : '−'}${Math.abs(delta)}`;
}

function formatSignedCost(curr: number | null, prev: number | null): string {
  if (curr === null || prev === null) return '—';
  const delta = curr - prev;
  if (delta === 0) return formatCost(0);
  return `${delta > 0 ? '+' : '−'}${formatCost(Math.abs(delta))}`;
}

function formatSignedDuration(curr: number | null | undefined, prev: number | null | undefined): string {
  if (typeof curr !== 'number' || typeof prev !== 'number') return '—';
  const delta = curr - prev;
  if (delta === 0) return '0s';
  return `${delta > 0 ? '+' : '−'}${formatDurationMs(Math.abs(delta))}`;
}

function renderKpiDeltaLine(prev: KpiHistoryRecord, curr: KpiHistoryRecord): string {
  const parts = [
    `runs ${formatSignedInt(curr.runs, prev.runs)}`,
    `merge ${formatSignedPp(curr.mergeRate, prev.mergeRate)}`,
    `rework ${formatSignedPp(curr.reworkRate, prev.reworkRate)}`,
    `stuck ${formatSignedPp(curr.stuckRate, prev.stuckRate)}`,
    `human ${formatSignedPp(curr.humanInterventionRate, prev.humanInterventionRate)}`,
    `auto ${formatSignedPp(curr.fullyAutonomousRate, prev.fullyAutonomousRate)}`,
    `$/merged ${formatSignedCost(curr.costPerMergedPr, prev.costPerMergedPr)}`,
    `cycle p50 ${formatSignedDuration(curr.medianCycleTimeMs, prev.medianCycleTimeMs)}`,
    `cycle p90 ${formatSignedDuration(curr.p90CycleTimeMs, prev.p90CycleTimeMs)}`,
  ];
  return `Δ vs previous: ${parts.join(' · ')}`;
}

export function renderKpiTrend(records: KpiHistoryRecord[], opts: { window?: number } = {}): string {
  const window = opts.window ?? 14;
  const lines = ['## Health KPI trend', ''];

  if (records.length === 0) {
    lines.push('No KPI history yet.');
    return `${lines.join('\n')}\n`;
  }

  const visible = records.slice(-window);
  lines.push(
    '| date | runs | merge | rework | stuck | human | auto | $/merged | cycle p50 | cycle p90 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...visible.map((record) => {
      const columns = [
        record.date,
        String(record.runs),
        formatPercent(record.mergeRate),
        formatPercent(record.reworkRate),
        formatPercent(record.stuckRate),
        formatPercent(record.humanInterventionRate),
        typeof record.fullyAutonomousRate === 'number' ? formatPercent(record.fullyAutonomousRate) : '—',
        record.costPerMergedPr === null ? '—' : formatCost(record.costPerMergedPr),
        typeof record.medianCycleTimeMs === 'number' ? formatDurationMs(record.medianCycleTimeMs) : '—',
        typeof record.p90CycleTimeMs === 'number' ? formatDurationMs(record.p90CycleTimeMs) : '—',
      ];
      return `| ${columns.join(' | ')} |`;
    }),
  );

  if (records.length >= 2) {
    const prev = records[records.length - 2];
    const curr = records[records.length - 1];
    lines.push('', renderKpiDeltaLine(prev, curr));
  }

  return `${lines.join('\n')}\n`;
}
