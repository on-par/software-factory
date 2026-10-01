import type { CostEntry, FactoryEvent, HealthKpis } from '@on-par/factory-core';

export type HealthWindowName = 'run' | '24h';

export const HEALTH_WINDOW_LABELS: Record<HealthWindowName, string> = { run: 'this run', '24h': 'last 24h' };

export const DAY_MS = 24 * 60 * 60 * 1000;

export interface HealthHeadlineRow {
  label: string;
  value: string;
}

const NO_RUNS = 'unknown (no runs in window)';
const NO_MERGED = 'unknown (no merged runs in window)';

export function resolveHealthWindowStart(
  window: HealthWindowName,
  runStartedAt: string | undefined,
  now: number,
): number | null {
  if (window === '24h') return now - DAY_MS;
  if (runStartedAt === undefined) return null;
  const parsed = Date.parse(runStartedAt);
  return Number.isNaN(parsed) ? null : parsed;
}

export function filterToWindow(
  events: FactoryEvent[],
  costs: CostEntry[],
  startMs: number | null,
): { events: FactoryEvent[]; costs: CostEntry[] } {
  if (startMs === null) return { events: [], costs: [] };
  const inWindow = (ts: string): boolean => Date.parse(ts) >= startMs;
  return { events: events.filter((e) => inWindow(e.ts)), costs: costs.filter((c) => inWindow(c.ts)) };
}

function pct(r: number): string {
  return `${Math.round(r * 100)}%`;
}

export function formatHealthHeadline(kpis: HealthKpis): HealthHeadlineRow[] {
  const labels = ['Merge rate', 'Rework rate', 'Stuck lanes', 'Median cost/merged PR', 'Throughput'];
  if (kpis.runs === 0) return labels.map((label) => ({ label, value: NO_RUNS }));

  let cost: string;
  if (kpis.merged === 0) cost = NO_MERGED;
  else if (kpis.medianCostPerMergedPr === null) cost = 'unknown (no cost rows for merged runs)';
  else {
    const coverage = kpis.costCoverage === null ? 'unknown' : pct(kpis.costCoverage);
    cost = `$${kpis.medianCostPerMergedPr.toFixed(2)} (${kpis.costScoredMergedRuns}/${kpis.merged} merged costed · coverage ${coverage})`;
  }

  let throughput: string;
  if (kpis.merged === 0) throughput = NO_MERGED;
  else if (kpis.prsPerHour === null) throughput = 'unknown (window too short)';
  else throughput = `${kpis.prsPerHour.toFixed(2)} PRs/hour`;

  return [
    { label: labels[0], value: `${pct(kpis.mergeRate)} (${kpis.merged}/${kpis.runs})` },
    { label: labels[1], value: `${pct(kpis.reworkRate)} (${kpis.reworkRuns}/${kpis.runs})` },
    { label: labels[2], value: `${kpis.stuckRuns} of ${kpis.runs} runs` },
    { label: labels[3], value: cost },
    { label: labels[4], value: throughput },
  ];
}
