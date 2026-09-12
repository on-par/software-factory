import { describe, expect, it } from 'vitest';

import { toUsageHeadroomView, USAGE_UNAVAILABLE_REASON, type UsageHeadroomReading } from './usageHeadroomState.js';

function reading(overrides: Partial<UsageHeadroomReading> = {}): UsageHeadroomReading {
  return {
    pct: 0.42,
    cap: 227,
    source: 'subscription',
    nextPollAt: '2026-08-19T00:05:30.000Z',
    ...overrides,
  };
}

describe('toUsageHeadroomView', () => {
  it('maps a subscription reading to an available view', () => {
    const view = toUsageHeadroomView(reading());
    expect(view.available).toBe(true);
    if (!view.available) throw new Error('expected available view');
    expect(view.pctLabel).toBe('42%');
    expect(view.capLabel).toBe('$227');
    expect(view.sourceLabel).toContain('subscription');
    expect(view.sourceLabel).toContain('plan limit');
    expect(view.nextPollLabel).toBe('00:05:30 UTC');
    expect(view.pctValue).toBe(42);
  });

  it('maps an estimate reading to the list-price source label', () => {
    const view = toUsageHeadroomView(reading({ source: 'estimate' }));
    if (!view.available) throw new Error('expected available view');
    expect(view.sourceLabel).toBe('list-price estimate');
  });

  it('rounds pct to the nearest whole percent', () => {
    const view = toUsageHeadroomView(reading({ pct: 0.666 }));
    if (!view.available) throw new Error('expected available view');
    expect(view.pctLabel).toBe('67%');
  });

  it('allows pct above 1 without clamping the reported value', () => {
    const view = toUsageHeadroomView(reading({ pct: 1.2 }));
    if (!view.available) throw new Error('expected available view');
    expect(view.pctLabel).toBe('120%');
    expect(view.pctValue).toBe(120);
  });

  it('renders "unknown" for an unparseable nextPollAt', () => {
    const view = toUsageHeadroomView(reading({ nextPollAt: 'not-a-date' }));
    if (!view.available) throw new Error('expected available view');
    expect(view.nextPollLabel).toBe('unknown');
  });

  it('maps null to the unavailable view using the exported reason constant', () => {
    const view = toUsageHeadroomView(null);
    expect(view).toEqual({ available: false, reason: USAGE_UNAVAILABLE_REASON });
    expect(USAGE_UNAVAILABLE_REASON).toContain('not gating');
  });
});
