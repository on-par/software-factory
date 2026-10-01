import type { CostEntry, FactoryEvent, HealthKpis } from '@on-par/factory-core';
import { describe, expect, it } from 'vitest';

import { DAY_MS, filterToWindow, formatHealthHeadline, resolveHealthWindowStart } from './health-window.js';

const T = '2026-01-01T12:00:00.000Z';
const TMS = Date.parse(T);

function kpis(overrides: Partial<HealthKpis> = {}): HealthKpis {
  return {
    runs: 2,
    merged: 1,
    reworkRuns: 1,
    stuckRuns: 0,
    mergeRate: 0.5,
    reworkRate: 0.5,
    costScoredMergedRuns: 1,
    medianCostPerMergedPr: 1.234,
    costCoverage: 0.8,
    prsPerHour: 0.5,
    ...overrides,
  } as HealthKpis;
}

describe('resolveHealthWindowStart', () => {
  it('uses now - 24h for the 24h window', () => {
    expect(resolveHealthWindowStart('24h', undefined, 1_000_000_000)).toBe(1_000_000_000 - DAY_MS);
  });
  it('parses the run start for the run window', () => {
    expect(resolveHealthWindowStart('run', T, 0)).toBe(TMS);
  });
  it('returns null with no or garbage run start', () => {
    expect(resolveHealthWindowStart('run', undefined, 0)).toBeNull();
    expect(resolveHealthWindowStart('run', 'garbage', 0)).toBeNull();
  });
});

describe('filterToWindow', () => {
  const ev = (ts: string): FactoryEvent => ({ ts, type: 'merged', issue: '1', msg: '' });
  const cost = (ts: string): CostEntry => ({
    ts,
    issue: '1',
    task: 'build',
    model: 'm',
    inputTokens: 1,
    outputTokens: 1,
    cost: 1,
  });
  it('keeps items at or after the start and drops earlier or unparseable ones', () => {
    const r = filterToWindow(
      [ev('2026-01-01T11:59:59.000Z'), ev(T), ev('nope')],
      [cost('2026-01-01T11:00:00.000Z'), cost('2026-01-01T12:01:00.000Z')],
      TMS,
    );
    expect(r.events.map((e) => e.ts)).toEqual([T]);
    expect(r.costs.map((c) => c.ts)).toEqual(['2026-01-01T12:01:00.000Z']);
  });
  it('returns nothing for a null start', () => {
    expect(filterToWindow([ev(T)], [cost(T)], null)).toEqual({ events: [], costs: [] });
  });
});

describe('formatHealthHeadline', () => {
  it('reads unknown on every row when there are no runs', () => {
    const rows = formatHealthHeadline(kpis({ runs: 0, merged: 0 }));
    expect(rows).toHaveLength(5);
    for (const r of rows) expect(r.value).toBe('unknown (no runs in window)');
  });
  it('formats known figures', () => {
    const v = Object.fromEntries(formatHealthHeadline(kpis()).map((r) => [r.label, r.value]));
    expect(v['Merge rate']).toBe('50% (1/2)');
    expect(v['Rework rate']).toBe('50% (1/2)');
    expect(v['Stuck lanes']).toBe('0 of 2 runs');
    expect(v['Median cost/merged PR']).toMatch(/^\$1\.23 .*coverage 80%/);
    expect(v['Throughput']).toBe('0.50 PRs/hour');
  });
  it('reports unknown coverage', () => {
    const v = formatHealthHeadline(kpis({ costCoverage: null }))[3].value;
    expect(v).toContain('coverage unknown');
  });
  it('explains missing merged runs', () => {
    const rows = formatHealthHeadline(kpis({ merged: 0, medianCostPerMergedPr: null, prsPerHour: null }));
    expect(rows[3].value).toBe('unknown (no merged runs in window)');
    expect(rows[4].value).toBe('unknown (no merged runs in window)');
  });
  it('explains missing cost rows and short windows', () => {
    const rows = formatHealthHeadline(kpis({ medianCostPerMergedPr: null, prsPerHour: null }));
    expect(rows[3].value).toBe('unknown (no cost rows for merged runs)');
    expect(rows[4].value).toBe('unknown (window too short)');
  });
});
