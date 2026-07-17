import type { CostEntry, CostsRead } from '@on-par/factory-core';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';

import { CostsTab } from './CostsTab.js';

afterEach(cleanup);

function entry(overrides: Partial<CostEntry>): CostEntry {
  return {
    ts: '2026-01-01T00:00:00.000Z',
    issue: '61',
    task: 'build',
    model: 'claude-sonnet-5',
    inputTokens: 1000,
    outputTokens: 500,
    cost: 0.0123,
    ...overrides,
  };
}

describe('CostsTab', () => {
  it('shows "no cost data yet" when there are no entries', () => {
    const costs: CostsRead = { entries: [], skipped: 0 };
    const { lastFrame } = render(<CostsTab costs={costs} selectedIndex={0} />);
    expect(lastFrame()).toContain('no cost data yet');
  });

  it('renders per-issue rows, the per-model section for the selection, and the grand total', () => {
    const costs: CostsRead = {
      entries: [
        entry({ issue: '61', model: 'claude-sonnet-5', inputTokens: 1000, outputTokens: 500, cost: 0.01 }),
        entry({ issue: '62', model: 'gpt-5', inputTokens: 2000, outputTokens: 1000, cost: 0.02 }),
      ],
      skipped: 0,
    };
    const { lastFrame } = render(<CostsTab costs={costs} selectedIndex={0} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('#61');
    expect(frame).toContain('#62');
    expect(frame).toContain('per-model — #61');
    expect(frame).toContain('claude-sonnet-5');
    expect(frame).toContain('session total');
    expect(frame).toContain('$0.0300');
  });

  it('follows selectedIndex to show the per-model section for a different issue', () => {
    const costs: CostsRead = {
      entries: [entry({ issue: '61', model: 'claude-sonnet-5' }), entry({ issue: '62', model: 'gpt-5' })],
      skipped: 0,
    };
    const { lastFrame } = render(<CostsTab costs={costs} selectedIndex={1} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('per-model — #62');
    expect(frame).toContain('gpt-5');
  });

  it('shows a warning line only when skipped > 0', () => {
    const withSkips: CostsRead = { entries: [entry({})], skipped: 2 };
    expect(render(<CostsTab costs={withSkips} selectedIndex={0} />).lastFrame()).toContain(
      '⚠ skipped 2 malformed line(s) in costs.jsonl',
    );

    const noSkips: CostsRead = { entries: [entry({})], skipped: 0 };
    expect(render(<CostsTab costs={noSkips} selectedIndex={0} />).lastFrame()).not.toContain('skipped');
  });

  it('shows the warning even when there is no cost data', () => {
    const costs: CostsRead = { entries: [], skipped: 1 };
    const frame = render(<CostsTab costs={costs} selectedIndex={0} />).lastFrame() ?? '';
    expect(frame).toContain('⚠ skipped 1 malformed line(s) in costs.jsonl');
    expect(frame).toContain('no cost data yet');
  });
});
