import { aggregateCosts, type CostEntry, type IssueCostRow } from '@on-par/factory-core';

import type { LaneState } from '../dashboard.js';

export interface RunIssueCost extends IssueCostRow {
  lane: string;
  lastTs: string;
  merged: boolean;
}

export interface LaneCostTotal {
  lane: string;
  cost: number | null;
  unpricedCount: number;
}

export interface RunCostsSummary {
  /** Earliest LaneState.startedAt; undefined when no run is in progress. */
  runStartedAt?: string;
  /** This run's issues, most recent cost row first. */
  issues: RunIssueCost[];
  total: { inputTokens: number; outputTokens: number; cost: number | null; unpricedCount: number };
  byLane: LaneCostTotal[];
  /** Median cost of merged issues with a known cost; null when there are none. */
  medianMergedCost: number | null;
  mergedCount: number;
  allTime: { cost: number | null; unpricedCount: number };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Scopes cost rows to the current run (ts >= the earliest lane start) and rolls them up per issue and lane (#1739). */
export function summarizeRunCosts(entries: CostEntry[], lanes: LaneState[]): RunCostsSummary {
  const all = aggregateCosts(entries).total;
  const allTime = { cost: all.cost, unpricedCount: all.unpricedCount };

  let runStartedAt: string | undefined;
  let startMs = Infinity;
  for (const lane of lanes) {
    const ms = Date.parse(lane.startedAt);
    if (!Number.isNaN(ms) && ms < startMs) {
      startMs = ms;
      runStartedAt = lane.startedAt;
    }
  }
  if (runStartedAt === undefined) {
    return {
      issues: [],
      total: { inputTokens: 0, outputTokens: 0, cost: 0, unpricedCount: 0 },
      byLane: [],
      medianMergedCost: null,
      mergedCount: 0,
      allTime,
    };
  }

  const runEntries = entries.filter((e) => Date.parse(e.ts) >= startMs);
  const lastTsByIssue = new Map<string, string>();
  for (const e of runEntries) {
    const prev = lastTsByIssue.get(e.issue);
    if (prev === undefined || Date.parse(e.ts) > Date.parse(prev)) lastTsByIssue.set(e.issue, e.ts);
  }

  const agg = aggregateCosts(runEntries);
  const issues: RunIssueCost[] = agg.perIssue.map((row) => {
    const laneState = lanes.find((l) => l.issue === row.issue);
    return {
      ...row,
      lane: laneState?.lane ?? 'default',
      merged: laneState?.status === 'merged',
      lastTs: lastTsByIssue.get(row.issue) ?? runStartedAt,
    };
  });
  issues.sort((a, b) => Date.parse(b.lastTs) - Date.parse(a.lastTs));

  const laneAcc = new Map<string, { sum: number; priced: number; unpricedCount: number }>();
  for (const issue of issues) {
    const acc = laneAcc.get(issue.lane) ?? { sum: 0, priced: 0, unpricedCount: 0 };
    if (issue.cost !== null) {
      acc.sum += issue.cost;
      acc.priced += 1;
    }
    acc.unpricedCount += issue.unpricedCount;
    laneAcc.set(issue.lane, acc);
  }
  const byLane: LaneCostTotal[] = [...laneAcc].map(([lane, acc]) => ({
    lane,
    cost: acc.priced === 0 && acc.unpricedCount > 0 ? null : acc.sum,
    unpricedCount: acc.unpricedCount,
  }));

  const mergedCosts = issues.flatMap((i) => (i.merged && i.cost !== null ? [i.cost] : []));

  return {
    runStartedAt,
    issues,
    total: agg.total,
    byLane,
    medianMergedCost: median(mergedCosts),
    mergedCount: mergedCosts.length,
    allTime,
  };
}

/** The issue the Costs tab highlights: the kept selection, else the running issue, else the most recent (#1739). */
export function resolveCostsSelection(
  summary: RunCostsSummary,
  lanes: LaneState[],
  selectedIssue?: string,
): string | undefined {
  const inRun = (issue: string) => summary.issues.some((i) => i.issue === issue);
  if (selectedIssue !== undefined && inRun(selectedIssue)) return selectedIssue;
  const running = lanes.find((l) => l.status === 'running' && inRun(l.issue));
  if (running) return running.issue;
  return summary.issues[0]?.issue;
}

export function formatTokensShort(n: number): string {
  if (n < 1000) return String(Math.round(n));
  const strip = (s: string) => s.replace(/\.0$/, '');
  if (n < 1e6) return `${strip((n / 1e3).toFixed(1))}k`;
  return `${strip((n / 1e6).toFixed(1))}M`;
}

/** Joins segments with " · ", dropping trailing ones for a "+N more" tail so the line fits `width`. */
export function truncateSegments(prefix: string, segments: string[], width: number): string {
  const full = prefix + segments.join(' · ');
  if (full.length <= width) return full;
  for (let keep = segments.length - 1; keep >= 1; keep--) {
    const line = `${prefix}${segments.slice(0, keep).join(' · ')} · +${segments.length - keep} more`;
    if (line.length <= width) return line;
  }
  return `${prefix}+${segments.length} more`;
}
