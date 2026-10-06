// src/garden/harvest.ts — Read-only harvest: cluster CHECK-caused parks in events.ndjson by failure signature (#2083)

import { existsSync, readFileSync } from 'node:fs';

import { isParkKind } from '../events/kinds.js';
import type { FactoryEvent } from '../types/index.js';

export interface HarvestedEvent {
  event: FactoryEvent;
  /** `<events file path>:<1-based line>` — a path-only pointer to the run's park line. */
  pointer: string;
}

export interface GardenCluster {
  /** The CHECK failure signature. */
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
}

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

export function clusterCheckFailures(
  events: readonly HarvestedEvent[],
  opts: { sampleLimit?: number } = {},
): GardenCluster[] {
  const limit = opts.sampleLimit ?? DEFAULT_GARDEN_SAMPLE_LIMIT;
  const groups = new Map<string, HarvestedEvent[]>();
  for (const h of events) {
    const signature = h.event.checkFailure?.signature;
    if (!isParkKind(h.event.type) || typeof signature !== 'string' || signature === '') continue;
    const group = groups.get(signature);
    if (group) group.push(h);
    else groups.set(signature, [h]);
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

/** Wraps `s` in a backtick run longer than any inside it so it cannot break the markdown. */
function codeSpan(s: string): string {
  const flat = s.replace(/\n/g, ' ');
  const longest = Math.max(0, ...(flat.match(/`+/g) ?? []).map((r) => r.length));
  const fence = '`'.repeat(longest + 1);
  const pad = flat.startsWith('`') || flat.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${flat}${pad}${fence}`;
}

export function renderGardenReport(clusters: readonly GardenCluster[]): string[] {
  if (clusters.length === 0) return ['no clusters'];
  const lines = ['# Garden report: recurring CHECK failure signatures', ''];
  clusters.forEach((c, i) => {
    lines.push(
      `## ${i + 1}. ${codeSpan(c.key)}`,
      '',
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
  return lines;
}
