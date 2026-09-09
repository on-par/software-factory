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

describe('HealthTab', () => {
  it('shows the closed-breaker default when there are no open breakers', () => {
    const { lastFrame } = render(
      <HealthTab events={[]} costs={[]} breakers={[]} effectiveConfigLines={[]} showSecondary={false} />,
    );
    expect(lastFrame()).toContain('(closed)');
  });

  it('renders an open breaker row with provider, reason, and remaining time', () => {
    const breakers: BreakerRow[] = [{ provider: 'anthropic', reason: 'rate-limit', remainingMs: 90_000 }];
    const { lastFrame } = render(
      <HealthTab events={[]} costs={[]} breakers={breakers} effectiveConfigLines={[]} showSecondary={false} />,
    );
    expect(lastFrame()).toContain('anthropic: OPEN (rate-limit) — 2m remaining');
  });

  it('hides Effective config and KPIs behind a hint when showSecondary is false', () => {
    const { lastFrame } = render(
      <HealthTab events={[]} costs={[]} breakers={[]} effectiveConfigLines={['foo: bar']} showSecondary={false} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('(Effective config and KPIs hidden — press e to view)');
    expect(frame).not.toContain('foo: bar');
  });

  it('shows Effective config and at least one KPI line when showSecondary is true', () => {
    const { lastFrame } = render(
      <HealthTab
        events={[ev()]}
        costs={[entry()]}
        breakers={[]}
        effectiveConfigLines={['router: default']}
        showSecondary={true}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Effective config:');
    expect(frame).toContain('router: default');
    expect(frame).toContain('KPIs:');
    expect(frame).not.toContain('No factory runs recorded yet.');
  });
});
