import type { CostEntry, FactoryEvent } from '@on-par/factory-core';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';

import { type BreakerRow, HealthTab } from './HealthTab.js';

afterEach(cleanup);

function ev(overrides: Partial<FactoryEvent> = {}): FactoryEvent {
  return { ts: '2026-01-01T00:00:00.000Z', type: 'merged', issue: '296', msg: 'Merged', ...overrides };
}

function entry(overrides: Partial<CostEntry> = {}): CostEntry {
  return {
    ts: '2026-01-01T00:00:00.000Z',
    issue: '296',
    task: 'build',
    model: 'claude-sonnet-5',
    inputTokens: 1000,
    outputTokens: 500,
    cost: 0.0123,
    ...overrides,
  };
}

const T = '2026-01-01T12:00:00.000Z';
const NOW = Date.parse(T) + 3_600_000;
const W = { window: 'run' as const, runStartedAt: T, now: NOW };

describe('HealthTab', () => {
  it('shows the closed-breaker default when there are no open breakers', () => {
    const { lastFrame } = render(
      <HealthTab events={[]} costs={[]} breakers={[]} effectiveConfigLines={[]} showSecondary={false} {...W} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Breaker:');
    expect(frame).toContain('closed');
    expect(frame).toContain('Merge rate');
  });

  it('renders an open breaker row with provider, reason, and remaining time', () => {
    const breakers: BreakerRow[] = [{ provider: 'anthropic', reason: 'rate-limit', remainingMs: 90_000 }];
    const { lastFrame } = render(
      <HealthTab events={[]} costs={[]} breakers={breakers} effectiveConfigLines={[]} showSecondary={false} {...W} />,
    );
    expect(lastFrame()).toContain('anthropic: OPEN (rate-limit) — 2m remaining');
  });

  it('hides Effective config and KPIs behind a hint when showSecondary is false', () => {
    const { lastFrame } = render(
      <HealthTab
        events={[]}
        costs={[]}
        breakers={[]}
        effectiveConfigLines={['foo: bar']}
        showSecondary={false}
        {...W}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('(Effective config and full KPIs hidden — press e to view)');
    expect(frame).not.toContain('foo: bar');
  });

  it('shows Effective config and at least one KPI line when showSecondary is true', () => {
    const { lastFrame } = render(
      <HealthTab
        events={[ev({ ts: '2026-01-01T12:01:00.000Z' })]}
        costs={[entry({ ts: '2026-01-01T12:02:00.000Z' })]}
        breakers={[]}
        effectiveConfigLines={['router: default']}
        showSecondary={true}
        {...W}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Effective config:');
    expect(frame).toContain('router: default');
    expect(frame).toContain('KPIs:');
    expect(frame).not.toContain('No factory runs recorded yet.');
  });

  it('titles the tab with the window', () => {
    const run = render(
      <HealthTab events={[]} costs={[]} breakers={[]} effectiveConfigLines={[]} showSecondary={false} {...W} />,
    );
    expect(run.lastFrame()).toContain('Health — this run');
    const day = render(
      <HealthTab
        events={[]}
        costs={[]}
        breakers={[]}
        effectiveConfigLines={[]}
        showSecondary={false}
        {...W}
        window="24h"
      />,
    );
    expect(day.lastFrame()).toContain('Health — last 24h');
  });

  it('excludes cost rows from before the window start', () => {
    const events = [ev({ ts: '2026-01-01T12:01:00.000Z' })];
    const costs = [
      entry({ ts: '2026-01-01T11:00:00.000Z', cost: 5 }),
      entry({ ts: '2026-01-01T12:02:00.000Z', cost: 0.25 }),
    ];
    const { lastFrame } = render(
      <HealthTab events={events} costs={costs} breakers={[]} effectiveConfigLines={[]} showSecondary={true} {...W} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('$0.25');
    expect(frame).not.toContain('$5.00');
    expect(frame).not.toContain('$5.25');
  });

  it('reads unknown, never blank, when the window holds no runs', () => {
    const events = [ev({ ts: '2025-12-31T00:00:00.000Z' })];
    const { lastFrame } = render(
      <HealthTab events={events} costs={[]} breakers={[]} effectiveConfigLines={[]} showSecondary={false} {...W} />,
    );
    const count = (lastFrame() ?? '').split('unknown (no runs in window)').length - 1;
    expect(count).toBeGreaterThanOrEqual(5);
  });

  it('reads unknown when no run is in progress', () => {
    const { lastFrame } = render(
      <HealthTab
        events={[ev()]}
        costs={[]}
        breakers={[]}
        effectiveConfigLines={[]}
        showSecondary={false}
        {...W}
        runStartedAt={undefined}
      />,
    );
    expect(lastFrame()).toContain('unknown (no runs in window)');
  });
});
