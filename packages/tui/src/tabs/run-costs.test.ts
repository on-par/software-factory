import type { CostEntry } from '@on-par/factory-core';
import { describe, expect, it } from 'vitest';

import type { LaneState } from '../dashboard.js';
import { initialState } from '../state.js';
import { formatTokensShort, resolveCostsSelection, summarizeRunCosts, truncateSegments } from './run-costs.js';

const START = '2026-01-02T00:00:00.000Z';

function entry(overrides: Partial<CostEntry>): CostEntry {
  return {
    ts: START,
    issue: '61',
    task: 'build',
    model: 'm',
    inputTokens: 10,
    outputTokens: 5,
    cost: 1,
    ...overrides,
  };
}

function lane(issue: string, overrides: Partial<LaneState> = {}): LaneState {
  return {
    issue,
    lane: 'default',
    run: initialState(),
    status: 'running',
    startedAt: START,
    lastEventAt: START,
    ...overrides,
  };
}

describe('summarizeRunCosts', () => {
  it('sums only rows at or after the earliest lane start; allTime sums everything', () => {
    const entries = [
      entry({ ts: '2025-12-01T00:00:00.000Z', cost: 100 }),
      entry({ ts: START, cost: 2 }),
      entry({ ts: '2026-01-03T00:00:00.000Z', cost: 3 }),
      entry({ ts: 'garbage', cost: 1000 }),
    ];
    const s = summarizeRunCosts(entries, [lane('61', { startedAt: '2026-01-02T05:00:00.000Z' }), lane('62')]);
    expect(s.runStartedAt).toBe(START);
    expect(s.total.cost).toBe(5);
    expect(s.allTime.cost).toBe(1105);
  });

  it('returns an empty run when there are no lanes', () => {
    const s = summarizeRunCosts([entry({})], []);
    expect(s.runStartedAt).toBeUndefined();
    expect(s.issues).toEqual([]);
    expect(s.allTime.cost).toBe(1);
  });

  it('orders issues by latest ts descending and attaches lanes with a default fallback', () => {
    const entries = [
      entry({ issue: '1', ts: '2026-01-02T01:00:00.000Z' }),
      entry({ issue: '2', ts: '2026-01-02T03:00:00.000Z' }),
      entry({ issue: '1', ts: '2026-01-02T02:00:00.000Z' }),
      entry({ issue: '3', ts: '2026-01-02T00:30:00.000Z' }),
    ];
    const s = summarizeRunCosts(entries, [lane('1', { lane: 'a' }), lane('2', { lane: 'b' })]);
    expect(s.issues.map((i) => i.issue)).toEqual(['2', '1', '3']);
    expect(s.issues.map((i) => i.lane)).toEqual(['b', 'a', 'default']);
    expect(s.issues[1].lastTs).toBe('2026-01-02T02:00:00.000Z');
  });

  it('totals per lane and reports null for an all-unpriced lane', () => {
    const entries = [entry({ issue: '1', cost: 1 }), entry({ issue: '2', cost: 2 }), entry({ issue: '3', cost: null })];
    const s = summarizeRunCosts(entries, [
      lane('1', { lane: 'a' }),
      lane('2', { lane: 'a' }),
      lane('3', { lane: 'b' }),
    ]);
    expect(s.byLane.find((l) => l.lane === 'a')).toMatchObject({ cost: 3, unpricedCount: 0 });
    expect(s.byLane.find((l) => l.lane === 'b')).toMatchObject({ cost: null, unpricedCount: 1 });
  });

  it('computes the merged median for odd, even, none, and skips unpriced', () => {
    const mk = (costs: (number | null)[]) =>
      summarizeRunCosts(
        costs.map((cost, i) => entry({ issue: String(i), cost })),
        costs.map((_, i) => lane(String(i), { status: 'merged' })),
      );
    expect(mk([1, 5, 3]).medianMergedCost).toBe(3);
    expect(mk([1, 2, 3, 10]).medianMergedCost).toBe(2.5);
    const none = summarizeRunCosts([entry({})], [lane('61')]);
    expect(none.medianMergedCost).toBeNull();
    expect(none.mergedCount).toBe(0);
    const withUnpriced = mk([null, 4]);
    expect(withUnpriced.medianMergedCost).toBe(4);
    expect(withUnpriced.mergedCount).toBe(1);
  });
});

describe('resolveCostsSelection', () => {
  const entries = [
    entry({ issue: '1', ts: '2026-01-02T02:00:00.000Z' }),
    entry({ issue: '2', ts: '2026-01-02T01:00:00.000Z' }),
  ];

  it('keeps a selection that is in the run', () => {
    const lanes = [lane('1'), lane('2')];
    expect(resolveCostsSelection(summarizeRunCosts(entries, lanes), lanes, '2')).toBe('2');
  });

  it('falls back from a stale selection to the running issue', () => {
    const lanes = [lane('1', { status: 'merged' }), lane('2')];
    expect(resolveCostsSelection(summarizeRunCosts(entries, lanes), lanes, '99')).toBe('2');
  });

  it('falls back to the most recent issue when nothing is running', () => {
    const lanes = [lane('1', { status: 'merged' }), lane('2', { status: 'merged' })];
    expect(resolveCostsSelection(summarizeRunCosts(entries, lanes), lanes)).toBe('1');
  });

  it('returns undefined for an empty run', () => {
    expect(resolveCostsSelection(summarizeRunCosts([], []), [])).toBeUndefined();
  });
});

describe('formatTokensShort', () => {
  it('abbreviates thousands and millions', () => {
    expect(formatTokensShort(0)).toBe('0');
    expect(formatTokensShort(950)).toBe('950');
    expect(formatTokensShort(12_345)).toBe('12.3k');
    expect(formatTokensShort(1_000_000)).toBe('1M');
    expect(formatTokensShort(2_300_000)).toBe('2.3M');
  });
});

describe('truncateSegments', () => {
  const segs = ['#1 $1.00', '#2 $2.00', '#3 $3.00'];
  it('joins when it fits', () => {
    expect(truncateSegments('By: ', segs, 100)).toBe('By: #1 $1.00 · #2 $2.00 · #3 $3.00');
  });
  it('truncates with +N more', () => {
    expect(truncateSegments('By: ', segs, 33)).toBe('By: #1 $1.00 · #2 $2.00 · +1 more');
  });
  it('falls back to just the count when nothing fits', () => {
    expect(truncateSegments('By: ', segs, 5)).toBe('By: +3 more');
  });
});
