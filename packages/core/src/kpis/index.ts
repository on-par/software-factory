// src/kpis/index.ts — Pure aggregation of factory health KPIs from events + cost rows

import type { CostEntry, FactoryEvent } from '../types/index.js';

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
  reworkRuns: number;
  stuckRuns: number;
  interventionRuns: number;
  mergeRate: number;
  reworkRate: number;
  stuckRate: number;
  humanInterventionRate: number;
  totalCost: number;
  costPerMergedPr: number | null;
  medianCycleTimeMs: number | null;
  p90CycleTimeMs: number | null;
  phaseDurations: Record<string, number>;
  queueWaitMs: number | null;
  cycleTimeExcludedRuns: number;
}

interface RunStats {
  merged: boolean;
  reworked: boolean;
  stuck: boolean;
  intervened: boolean;
  firstTs: number | null;
  mergedTs: number | null;
  firstPhaseTs: number | null;
  phaseWindows: Map<string, { first: number; last: number }>;
}

const INTERVENTION_EVENT_TYPES = new Set(['parked', 'escalate', 'awaiting-review']);

export function computeHealthKpis(events: FactoryEvent[], costs: CostEntry[]): HealthKpis {
  const runsByIssue = new Map<string, RunStats>();

  for (const event of events) {
    if (!isRealIssue(event.issue)) continue;

    const stats = runsByIssue.get(event.issue) ?? {
      merged: false,
      reworked: false,
      stuck: false,
      intervened: false,
      firstTs: null,
      mergedTs: null,
      firstPhaseTs: null,
      phaseWindows: new Map<string, { first: number; last: number }>(),
    };

    if (event.type === 'merged') stats.merged = true;
    if (event.type === 'rework' || event.rework) stats.reworked = true;
    if (event.type === 'stuck' || event.rework?.stuck === true) stats.stuck = true;
    if (INTERVENTION_EVENT_TYPES.has(event.type)) stats.intervened = true;

    const ts = Date.parse(event.ts);
    if (!Number.isNaN(ts)) {
      if (stats.firstTs === null || ts < stats.firstTs) stats.firstTs = ts;
      if (event.type === 'merged' && stats.mergedTs === null) stats.mergedTs = ts;
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
  let interventionRuns = 0;
  const cycleTimes: number[] = [];
  const queueWaits: number[] = [];
  const phaseSamples = new Map<string, number[]>();

  for (const stats of runsByIssue.values()) {
    if (stats.merged) merged++;
    if (stats.reworked) reworkRuns++;
    if (stats.stuck) stuckRuns++;
    if (stats.intervened) interventionRuns++;

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
    interventionRuns,
    mergeRate: runs === 0 ? 0 : merged / runs,
    reworkRate: runs === 0 ? 0 : reworkRuns / runs,
    stuckRate: runs === 0 ? 0 : stuckRuns / runs,
    humanInterventionRate: runs === 0 ? 0 : interventionRuns / runs,
    totalCost,
    costPerMergedPr: merged === 0 ? null : totalCost / merged,
    medianCycleTimeMs: percentileFromSorted(sortedCycleTimes, 0.5),
    p90CycleTimeMs: percentileFromSorted(sortedCycleTimes, 0.9),
    phaseDurations,
    queueWaitMs: percentile(queueWaits, 0.5),
    cycleTimeExcludedRuns: runs - cycleTimes.length,
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
    `Human-intervention rate: ${formatPercent(kpis.humanInterventionRate)} (${kpis.interventionRuns}/${kpis.runs})`,
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
  costPerMergedPr: number | null;
  medianCycleTimeMs: number | null;
  p90CycleTimeMs: number | null;
}

export function kpisToHistoryRecord(kpis: HealthKpis, date: string): KpiHistoryRecord {
  return {
    date,
    runs: kpis.runs,
    mergeRate: kpis.mergeRate,
    reworkRate: kpis.reworkRate,
    stuckRate: kpis.stuckRate,
    humanInterventionRate: kpis.humanInterventionRate,
    costPerMergedPr: kpis.costPerMergedPr,
    medianCycleTimeMs: kpis.medianCycleTimeMs,
    p90CycleTimeMs: kpis.p90CycleTimeMs,
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

export function renderKpiTrend(records: KpiHistoryRecord[], opts: { window?: number } = {}): string {
  const window = opts.window ?? 14;
  const lines = ['## Health KPI trend', ''];

  if (records.length === 0) {
    lines.push('No KPI history yet.');
    return `${lines.join('\n')}\n`;
  }

  const visible = records.slice(-window);
  lines.push(
    '| date | runs | merge | rework | stuck | human | $/merged | cycle p50 | cycle p90 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...visible.map((record) => {
      const columns = [
        record.date,
        String(record.runs),
        formatPercent(record.mergeRate),
        formatPercent(record.reworkRate),
        formatPercent(record.stuckRate),
        formatPercent(record.humanInterventionRate),
        record.costPerMergedPr === null ? '—' : formatCost(record.costPerMergedPr),
        typeof record.medianCycleTimeMs === 'number' ? formatDurationMs(record.medianCycleTimeMs) : '—',
        typeof record.p90CycleTimeMs === 'number' ? formatDurationMs(record.p90CycleTimeMs) : '—',
      ];
      return `| ${columns.join(' | ')} |`;
    }),
  );

  return `${lines.join('\n')}\n`;
}
