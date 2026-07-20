// src/kpis/index.ts — Pure aggregation of factory health KPIs from events + cost rows

import type { CostEntry, FactoryEvent } from '../types/index.js';

function isRealIssue(issue: string): boolean {
  return /^\d+$/.test(issue);
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
}

interface RunFlags {
  merged: boolean;
  reworked: boolean;
  stuck: boolean;
  intervened: boolean;
}

const INTERVENTION_EVENT_TYPES = new Set(['parked', 'escalate', 'awaiting-review']);

export function computeHealthKpis(events: FactoryEvent[], costs: CostEntry[]): HealthKpis {
  const runsByIssue = new Map<string, RunFlags>();

  for (const event of events) {
    if (!isRealIssue(event.issue)) continue;

    const flags = runsByIssue.get(event.issue) ?? {
      merged: false,
      reworked: false,
      stuck: false,
      intervened: false,
    };

    if (event.type === 'merged') flags.merged = true;
    if (event.type === 'rework' || event.rework) flags.reworked = true;
    if (event.type === 'stuck' || event.rework?.stuck === true) flags.stuck = true;
    if (INTERVENTION_EVENT_TYPES.has(event.type)) flags.intervened = true;

    runsByIssue.set(event.issue, flags);
  }

  const runs = runsByIssue.size;
  let merged = 0;
  let reworkRuns = 0;
  let stuckRuns = 0;
  let interventionRuns = 0;

  for (const flags of runsByIssue.values()) {
    if (flags.merged) merged++;
    if (flags.reworked) reworkRuns++;
    if (flags.stuck) stuckRuns++;
    if (flags.intervened) interventionRuns++;
  }

  const totalCost = costs.reduce((sum, entry) => sum + (entry.cost ?? 0), 0);

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

  return [
    `Runs: ${kpis.runs}`,
    `Merge rate: ${formatPercent(kpis.mergeRate)} (${kpis.merged}/${kpis.runs})`,
    `Rework rate: ${formatPercent(kpis.reworkRate)} (${kpis.reworkRuns}/${kpis.runs})`,
    `Stuck rate: ${formatPercent(kpis.stuckRate)} (${kpis.stuckRuns}/${kpis.runs})`,
    `Human-intervention rate: ${formatPercent(kpis.humanInterventionRate)} (${kpis.interventionRuns}/${kpis.runs})`,
    `Cost per merged PR: ${kpis.costPerMergedPr === null ? 'n/a' : formatCost(kpis.costPerMergedPr)}`,
  ];
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
    '| date | runs | merge | rework | stuck | human | $/merged |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...visible.map((record) => {
      const columns = [
        record.date,
        String(record.runs),
        formatPercent(record.mergeRate),
        formatPercent(record.reworkRate),
        formatPercent(record.stuckRate),
        formatPercent(record.humanInterventionRate),
        record.costPerMergedPr === null ? '—' : formatCost(record.costPerMergedPr),
      ];
      return `| ${columns.join(' | ')} |`;
    }),
  );

  return `${lines.join('\n')}\n`;
}
