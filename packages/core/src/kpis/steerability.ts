// src/kpis/steerability.ts — Steers per merged PR by lane and ISO week (#3403)

import { listSteerEvents } from '../run/steer.js';
import type { IssueRunState } from '../types/index.js';
import { median } from '../utils/median.js';
import type { ClassifierOutcomeRecord } from './classifier-outcomes.js';

export interface MergedPrSteers {
  issue: number;
  prNumber: number;
  lane: string;
  mergedAt: string;
  steers: number;
}

export interface SteerDistribution {
  min: number;
  median: number;
  max: number;
  /** Steer count (as a string key, "0".."max") → how many PRs had exactly that many. */
  histogram: Record<string, number>;
}

export interface SteerBucket {
  key: string;
  mergedPrs: number;
  steers: number;
  steersPerMergedPr: number | null;
  distribution: SteerDistribution | null;
}

export interface SteerabilityReport {
  schemaVersion: 1;
  total: SteerBucket;
  byLane: SteerBucket[];
  byWeek: SteerBucket[];
  unmatchedMergedPrs: number;
}

const DAY_MS = 86_400_000;

/** UTC ISO-8601 week key (`YYYY-Www`) for a timestamp; null when unparsable. */
export function isoWeekKey(iso: string): string | null {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  const day = d.getUTCDay() || 7;
  const thursday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 4 - day);
  const year = new Date(thursday).getUTCFullYear();
  const week = 1 + Math.floor((thursday - Date.UTC(year, 0, 1)) / (7 * DAY_MS));
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/**
 * Join merged classifier outcomes to run states by issue and count the steers inside each
 * PR's merge window (after the issue's previous merged PR, up to and including this one).
 */
export function collectMergedPrSteers(
  runs: readonly IssueRunState[],
  outcomes: readonly ClassifierOutcomeRecord[],
): { rows: MergedPrSteers[]; unmatched: number } {
  const byPr = new Map<number, ClassifierOutcomeRecord>();
  for (const r of outcomes) {
    if (r.merged && typeof r.mergedAt === 'string') byPr.set(r.prNumber, r);
  }
  const runByIssue = new Map<number, IssueRunState>();
  for (const run of runs) runByIssue.set(run.issue, run);

  const byIssue = new Map<number, { record: ClassifierOutcomeRecord; at: number }[]>();
  let unmatched = 0;
  for (const record of byPr.values()) {
    const issue = Number(record.issue);
    const at = Date.parse(record.mergedAt as string);
    if (!runByIssue.has(issue) || Number.isNaN(at)) {
      unmatched++;
      continue;
    }
    byIssue.set(issue, [...(byIssue.get(issue) ?? []), { record, at }]);
  }

  const rows: MergedPrSteers[] = [];
  for (const [issue, entries] of byIssue) {
    const state = runByIssue.get(issue) as IssueRunState;
    const steers = Array.isArray(state.steers) ? listSteerEvents(state) : [];
    const lane = typeof state.lane === 'string' && state.lane.length > 0 ? state.lane : 'unknown';
    entries.sort((a, b) => a.at - b.at);
    let prev = -Infinity;
    for (const { record, at } of entries) {
      const lower = prev;
      const count = steers.filter((s) => {
        const ts = Date.parse(s.ts);
        return ts > lower && ts <= at;
      }).length;
      rows.push({ issue, prNumber: record.prNumber, lane, mergedAt: record.mergedAt as string, steers: count });
      prev = at;
    }
  }
  rows.sort((a, b) => Date.parse(a.mergedAt) - Date.parse(b.mergedAt) || a.prNumber - b.prNumber);
  return { rows, unmatched };
}

function bucket(key: string, counts: number[]): SteerBucket {
  const mergedPrs = counts.length;
  const steers = counts.reduce((a, b) => a + b, 0);
  if (mergedPrs === 0) return { key, mergedPrs, steers, steersPerMergedPr: null, distribution: null };
  const sorted = [...counts].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[mergedPrs - 1];
  // mergedPrs > 0 here, so median() is never null; the fallback is unreachable.
  const medianSteers = median(sorted) ?? 0;
  const histogram: Record<string, number> = {};
  for (let i = 0; i <= max; i++) histogram[String(i)] = 0;
  for (const c of counts) histogram[String(c)]++;
  return {
    key,
    mergedPrs,
    steers,
    steersPerMergedPr: steers / mergedPrs,
    distribution: { min, median: medianSteers, max, histogram },
  };
}

function group(rows: readonly MergedPrSteers[], keyOf: (r: MergedPrSteers) => string | null): SteerBucket[] {
  const groups = new Map<string, number[]>();
  for (const r of rows) {
    const key = keyOf(r);
    if (key !== null) groups.set(key, [...(groups.get(key) ?? []), r.steers]);
  }
  return [...groups.keys()].sort().map((key) => bucket(key, groups.get(key) as number[]));
}

export function summarizeSteerability(rows: readonly MergedPrSteers[], unmatched = 0): SteerabilityReport {
  return {
    schemaVersion: 1,
    total: bucket(
      'all',
      rows.map((r) => r.steers),
    ),
    byLane: group(rows, (r) => r.lane),
    byWeek: group(rows, (r) => isoWeekKey(r.mergedAt)),
    unmatchedMergedPrs: unmatched,
  };
}

const fmt = (x: number | null): number => Number((x ?? 0).toFixed(2));

function bucketLines(b: SteerBucket): string[] {
  const d = b.distribution;
  if (d === null) return [];
  const hist = Object.entries(d.histogram)
    .map(([k, v]) => `${k}:${v}`)
    .join(' ');
  return [
    `${b.key.padEnd(12)} ${b.mergedPrs} PRs, ${b.steers} steers, ${fmt(b.steersPerMergedPr)} per PR, min ${d.min} / median ${d.median} / max ${d.max}`,
    `  histogram ${hist}`,
  ];
}

export function formatSteerabilityReport(report: SteerabilityReport): string[] {
  const lines = ['Steerability (steers per merged PR):'];
  if (report.total.mergedPrs === 0) {
    lines.push('No merged PRs with run state yet.');
  } else {
    lines.push(...bucketLines(report.total));
    lines.push('By lane:', ...report.byLane.flatMap(bucketLines));
    lines.push('By week:', ...report.byWeek.flatMap(bucketLines));
  }
  if (report.unmatchedMergedPrs > 0) {
    lines.push(`${report.unmatchedMergedPrs} merged PR(s) had no run state and were skipped`);
  }
  return lines;
}
