// src/garden/harvest.ts — Read-only harvest: cluster CHECK-caused parks in events.ndjson by failure signature (#2083)

import { existsSync, readFileSync } from 'node:fs';

import { eventTraitsFor, isParkKind } from '../events/kinds.js';
import type { FactoryEvent } from '../types/index.js';

export interface HarvestedEvent {
  event: FactoryEvent;
  /** `<events file path>:<1-based line>` — a path-only pointer to the run's park line. */
  pointer: string;
}

export type GardenDimension = 'signature' | 'park-reason' | 'checker' | 'human';

/** Whether an open issue already tracks a cluster (#2102); `unknown` when the issue search failed (#2103). */
export type GardenTracking = { status: 'tracked'; issue: number } | { status: 'new' } | { status: 'unknown' };

export interface GardenCluster {
  dimension: GardenDimension;
  /** The cluster key: CHECK failure signature, park event kind, checker name or human-* event kind, depending on `dimension`. */
  key: string;
  count: number;
  /** Distinct issue ids, sorted numerically (non-numeric last, code-unit order). */
  issues: string[];
  firstSeen: string;
  lastSeen: string;
  /** Up to sampleLimit pointers, ordered by ts ascending then pointer. */
  samples: string[];
  /** Union of checkFailure.failingChecks across the cluster, sorted. */
  failingChecks: string[];
  /** Set by dedupGardenClusters; absent when dedup did not run. */
  tracking?: GardenTracking;
}

const trackingLine = (t: GardenTracking): string =>
  t.status === 'tracked' ? `- tracked: #${t.issue}` : t.status === 'unknown' ? '- tracked: unknown' : '- new';

const DEFAULT_GARDEN_SAMPLE_LIMIT = 5;

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function readHarvestEvents(files: readonly string[]): HarvestedEvent[] {
  const out: HarvestedEvent[] = [];
  for (const file of files) {
    if (!existsSync(file)) continue;
    const lines = readFileSync(file, 'utf-8').split('\n');
    lines.forEach((line, i) => {
      if (!line.trim()) return;
      try {
        out.push({ event: JSON.parse(line) as FactoryEvent, pointer: `${file}:${i + 1}` });
      } catch {
        // malformed line — skipped, but its line number still counts
      }
    });
  }
  return out;
}

function compareIssues(a: string, b: string): number {
  const na = /^\d+$/.test(a);
  const nb = /^\d+$/.test(b);
  if (na && nb) return Number(a) - Number(b) || cmp(a, b);
  if (na) return -1;
  if (nb) return 1;
  return cmp(a, b);
}

function clusterByKeys(
  events: readonly HarvestedEvent[],
  dimension: GardenDimension,
  keysOf: (e: FactoryEvent) => string[],
  limit: number,
): GardenCluster[] {
  const groups = new Map<string, HarvestedEvent[]>();
  for (const h of events) {
    for (const key of new Set(keysOf(h.event))) {
      if (key === '') continue;
      const group = groups.get(key);
      if (group) group.push(h);
      else groups.set(key, [h]);
    }
  }
  const clusters: GardenCluster[] = [];
  for (const [key, group] of groups) {
    const timestamps = group.map((h) => h.event.ts).sort(cmp);
    const checks = new Set<string>();
    for (const h of group) {
      const failing: unknown = h.event.checkFailure?.failingChecks;
      if (Array.isArray(failing)) for (const c of failing) if (typeof c === 'string') checks.add(c);
    }
    clusters.push({
      dimension,
      key,
      count: group.length,
      issues: [...new Set(group.map((h) => String(h.event.issue)))].sort(compareIssues),
      firstSeen: timestamps[0] ?? '',
      lastSeen: timestamps[timestamps.length - 1] ?? '',
      samples: [...group]
        .sort((a, b) => cmp(a.event.ts, b.event.ts) || cmp(a.pointer, b.pointer))
        .slice(0, limit)
        .map((h) => h.pointer),
      failingChecks: [...checks].sort(cmp),
    });
  }
  return clusters.sort((a, b) => b.count - a.count || cmp(a.key, b.key));
}

export function clusterCheckFailures(
  events: readonly HarvestedEvent[],
  opts: { sampleLimit?: number } = {},
): GardenCluster[] {
  const limit = opts.sampleLimit ?? DEFAULT_GARDEN_SAMPLE_LIMIT;
  return clusterByKeys(
    events,
    'signature',
    (e) => {
      const signature: unknown = e.checkFailure?.signature;
      return isParkKind(e.type) && typeof signature === 'string' ? [signature] : [];
    },
    limit,
  );
}

/** A park that ends a run — excludes the `stuck` companion event so a timed-out run is not counted twice. */
function isTerminalPark(type: string): boolean {
  const t = eventTraitsFor(type);
  return t.isPark && t.isTerminal;
}

/** Drops every event of a run (same repo+issue, delimited by terminal events) that ended in `environment-released` (ADR-0141). */
function excludeEnvironmentReleases(events: readonly HarvestedEvent[]): HarvestedEvent[] {
  const pending = new Map<string, { h: HarvestedEvent; index: number }[]>();
  const kept: { h: HarvestedEvent; index: number }[] = [];
  events.forEach((h, index) => {
    const key = `${h.event.repo ?? ''}#${String(h.event.issue)}`;
    const buffer = pending.get(key) ?? [];
    buffer.push({ h, index });
    pending.set(key, buffer);
    if (!eventTraitsFor(h.event.type).isTerminal) return;
    if (h.event.type !== 'environment-released') kept.push(...buffer);
    pending.set(key, []);
  });
  for (const buffer of pending.values()) kept.push(...buffer);
  return kept.sort((a, b) => a.index - b.index).map((k) => k.h);
}

export function clusterGarden(events: readonly HarvestedEvent[], opts: { sampleLimit?: number } = {}): GardenCluster[] {
  const kept = excludeEnvironmentReleases(events);
  const limit = opts.sampleLimit ?? DEFAULT_GARDEN_SAMPLE_LIMIT;
  return [
    ...clusterCheckFailures(kept, opts),
    ...clusterByKeys(kept, 'park-reason', (e) => (isTerminalPark(e.type) ? [e.type] : []), limit),
    ...clusterByKeys(
      kept,
      'checker',
      (e) => {
        const failing: unknown = e.checkFailure?.failingChecks;
        return isTerminalPark(e.type) && Array.isArray(failing)
          ? failing.filter((c): c is string => typeof c === 'string')
          : [];
      },
      limit,
    ),
    ...clusterByKeys(
      kept,
      'human',
      (e) => (typeof e.type === 'string' && e.type.startsWith('human-') ? [e.type] : []),
      limit,
    ),
  ];
}

/** Wraps `s` in a backtick run longer than any inside it so it cannot break the markdown. */
function codeSpan(s: string): string {
  const flat = s.replace(/\n/g, ' ');
  const longest = Math.max(0, ...(flat.match(/`+/g) ?? []).map((r) => r.length));
  const fence = '`'.repeat(longest + 1);
  const pad = flat.startsWith('`') || flat.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${flat}${pad}${fence}`;
}

const DIMENSION_HEADINGS: Record<GardenDimension, string> = {
  signature: 'CHECK failure signatures',
  'park-reason': 'Park reasons',
  checker: 'Failing checkers',
  human: 'Human events',
};

export function renderGardenReport(clusters: readonly GardenCluster[]): string[] {
  if (clusters.length === 0) return ['no clusters'];
  const lines = ['# Garden report: recurring failure clusters', ''];
  for (const dimension of Object.keys(DIMENSION_HEADINGS) as GardenDimension[]) {
    const section = clusters.filter((c) => c.dimension === dimension);
    if (section.length === 0) continue;
    lines.push(`## ${DIMENSION_HEADINGS[dimension]}`, '');
    section.forEach((c, i) => {
      lines.push(
        `### ${i + 1}. ${codeSpan(c.key)}`,
        '',
        ...(c.tracking ? [trackingLine(c.tracking)] : []),
        `- count: ${c.count}`,
        `- distinct issues: ${c.issues.length} (${c.issues.map((n) => `#${n}`).join(', ')})`,
        `- first seen: ${c.firstSeen}`,
        `- last seen: ${c.lastSeen}`,
        `- failing checkers: ${c.failingChecks.length > 0 ? c.failingChecks.join(', ') : '(none)'}`,
        '- sample runs:',
        ...c.samples.map((s) => `  - ${s}`),
        '',
      );
    });
  }
  return lines;
}

export interface GardenReportMeta {
  /** The --since window as given, e.g. '14d'. */
  since: string;
  maxClusters: number;
}

export const DEFAULT_GARDEN_SINCE = '14d';
export const DEFAULT_GARDEN_MAX_CLUSTERS = 10;

const DURATION_UNIT_MS = { h: 3_600_000, d: 86_400_000, w: 604_800_000 } as const;

/** Parses a strict `<positive int><h|d|w>` window (e.g. `7d`) into ms; undefined when malformed. */
export function parseGardenDuration(input: string): number | undefined {
  const m = /^(\d+)([hdw])$/.exec(input);
  if (!m) return undefined;
  const n = Number(m[1]);
  return n > 0 ? n * DURATION_UNIT_MS[m[2] as keyof typeof DURATION_UNIT_MS] : undefined;
}

/** Keeps events whose ts is at or after `now - windowMs`; an event with a missing or unparseable ts is dropped. */
export function filterGardenWindow(events: readonly HarvestedEvent[], windowMs: number, now: Date): HarvestedEvent[] {
  const cutoff = now.getTime() - windowMs;
  return events.filter((h) => {
    const ts: unknown = h.event.ts;
    if (typeof ts !== 'string') return false;
    const t = Date.parse(ts);
    return Number.isFinite(t) && t >= cutoff;
  });
}

/** Keeps the `max` most recurrent clusters across all dimensions (count desc, ties by input order), in input order. */
export function capGardenClusters(clusters: readonly GardenCluster[], max: number): GardenCluster[] {
  const keep = new Set(
    clusters
      .map((c, i) => ({ c, i }))
      .sort((a, b) => b.c.count - a.c.count || a.i - b.i)
      .slice(0, max)
      .map((x) => x.i),
  );
  return clusters.filter((_, i) => keep.has(i));
}

/** The same clusters as one pretty-printed JSON document. */
export function renderGardenJson(clusters: readonly GardenCluster[], meta: GardenReportMeta): string {
  return JSON.stringify({ since: meta.since, maxClusters: meta.maxClusters, clusters }, null, 2);
}
