import type { CostEntry, CostsRead } from '@on-par/factory-core';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';

import type { LaneState } from '../dashboard.js';
import { initialState } from '../state.js';
import { CostsTab } from './CostsTab.js';

afterEach(cleanup);

function entry(overrides: Partial<CostEntry>): CostEntry {
  return {
    ts: '2026-01-02T00:00:00.000Z',
    issue: '61',
    task: 'build',
    model: 'claude-sonnet-5',
    inputTokens: 1000,
    outputTokens: 500,
    cost: 0.0123,
    ...overrides,
  };
}

function lane(issue: string, overrides: Partial<LaneState> = {}): LaneState {
  return {
    issue,
    lane: 'default',
    run: initialState(),
    status: 'running',
    startedAt: '2026-01-02T00:00:00.000Z',
    lastEventAt: '2026-01-02T00:00:00.000Z',
    ...overrides,
  };
}

const read = (entries: CostEntry[], skipped = 0): CostsRead => ({ entries, skipped });

describe('CostsTab', () => {
  it('shows "no cost data yet" when there are no entries', () => {
    const { lastFrame } = render(<CostsTab costs={read([])} lanes={[]} />);
    expect(lastFrame()).toContain('no cost data yet');
  });

  it('shows "no active run" and the all-time line when no lanes exist', () => {
    const { lastFrame } = render(<CostsTab costs={read([entry({ cost: 1 })])} lanes={[]} />);
    expect(lastFrame()).toContain('no active run');
    expect(lastFrame()).toContain('All-time (costs.jsonl): $1.00');
  });

  it('scopes "Spent this run" to rows at or after the run start', () => {
    const costs = read([
      entry({ ts: '2025-12-01T00:00:00.000Z', issue: '1', cost: 10 }),
      entry({ ts: '2025-12-15T00:00:00.000Z', issue: '2', cost: 20 }),
      entry({ ts: '2026-01-02T00:00:00.000Z', issue: '61', cost: 1.5 }),
      entry({ ts: '2026-01-02T01:00:00.000Z', issue: '62', cost: 2 }),
    ]);
    const { lastFrame } = render(<CostsTab costs={costs} lanes={[lane('61'), lane('62')]} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Spent this run: $3.50');
    expect(frame).not.toContain('$33.50 ·');
    expect(frame).toContain('All-time (costs.jsonl): $33.50');
    expect(frame).not.toContain('#1 ');
  });

  it('never says "session total"', () => {
    const { lastFrame } = render(<CostsTab costs={read([entry({})])} lanes={[lane('61')]} />);
    expect(lastFrame()).not.toContain('session total');
    expect(lastFrame()).toContain('All-time (costs.jsonl): $0.01');
  });

  it('puts every lane on a single By lane line', () => {
    const costs = read([entry({ issue: '61', cost: 1 }), entry({ issue: '62', cost: 2 })]);
    const lanes = [lane('61', { lane: 'lane-a' }), lane('62', { lane: 'lane-b' })];
    const { lastFrame } = render(<CostsTab costs={costs} lanes={lanes} />);
    const line = (lastFrame() ?? '').split('\n').find((l) => l.startsWith('By lane:'));
    expect(line).toContain('lane-a $1.00');
    expect(line).toContain('lane-b $2.00');
  });

  it('shows the median cost per merged PR with its count', () => {
    const costs = read([entry({ issue: '61', cost: 1 }), entry({ issue: '62', cost: 3 })]);
    const lanes = [lane('61', { status: 'merged' }), lane('62', { status: 'merged' })];
    const { lastFrame } = render(<CostsTab costs={costs} lanes={lanes} />);
    expect(lastFrame()).toContain('Median / merged PR: $2.00 (n=2)');
  });

  it('shows a dash when nothing has merged', () => {
    const { lastFrame } = render(<CostsTab costs={read([entry({})])} lanes={[lane('61')]} />);
    expect(lastFrame()).toContain('Median / merged PR: — (0 merged)');
  });

  it('hides per-model by default and defaults the expanded view to the running issue, not an old one', () => {
    const costs = read([
      entry({ ts: '2025-12-01T00:00:00.000Z', issue: '1', model: 'old-model' }),
      entry({ issue: '61', model: 'new-model', inputTokens: 2_300_000, outputTokens: 120_000 }),
    ]);
    const collapsed = render(<CostsTab costs={costs} lanes={[lane('61')]} />);
    expect(collapsed.lastFrame()).not.toContain('per-model —');
    const expanded = render(<CostsTab costs={costs} lanes={[lane('61')]} expanded />);
    const frame = expanded.lastFrame() ?? '';
    expect(frame).toContain('per-model — #61');
    expect(frame).toContain('new-model');
    expect(frame).toContain('2.3M');
    expect(frame).not.toContain('old-model');
  });

  it('stays within 12 lines and the width with 5 issues collapsed', () => {
    const ids = ['71', '72', '73', '74', '75'];
    const costs = read(ids.map((issue, i) => entry({ issue, ts: `2026-01-02T0${i}:00:00.000Z`, cost: i + 0.5 })));
    const { lastFrame } = render(<CostsTab costs={costs} lanes={ids.map((i) => lane(i))} width={100} />);
    const lines = (lastFrame() ?? '').split('\n');
    expect(lines.length).toBeLessThanOrEqual(12);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(100);
  });

  it('renders unknown, never $0.00, for an all-unpriced entry set', () => {
    const costs = read([entry({ cost: null })]);
    const { lastFrame } = render(<CostsTab costs={costs} lanes={[lane('61')]} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('unknown');
    expect(frame).toContain('1 unpriced');
    expect(frame).not.toContain('$0.00');
  });

  it('shows a warning line only when skipped > 0, even with no cost data', () => {
    const warn = '⚠ skipped 2 malformed line(s) in costs.jsonl';
    expect(render(<CostsTab costs={read([entry({})], 2)} lanes={[lane('61')]} />).lastFrame()).toContain(warn);
    expect(render(<CostsTab costs={read([entry({})])} lanes={[lane('61')]} />).lastFrame()).not.toContain('⚠');
    expect(render(<CostsTab costs={read([], 2)} lanes={[]} />).lastFrame()).toContain(warn);
  });
});
