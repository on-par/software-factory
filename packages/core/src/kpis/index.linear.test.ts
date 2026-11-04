import { describe, expect, it } from 'vitest';

import type { FactoryEvent } from '../types/index.js';
import { computeHealthKpis } from './index.js';

function event(overrides: Partial<FactoryEvent> = {}): FactoryEvent {
  return { ts: '2026-07-20T00:00:00.000Z', type: 'issue-title', issue: '1', msg: '', ...overrides };
}

describe('computeHealthKpis with Linear keys (#3894)', () => {
  it('counts a run keyed by a Linear WorkKey in the health KPIs', () => {
    const events: FactoryEvent[] = [
      event({ issue: 'ON-12', type: 'issue-title' }),
      event({ issue: 'ON-12', type: 'merged' }),
      event({ issue: 'issue-12', type: 'issue-title' }),
      event({ issue: '-', type: 'issue-title' }),
    ];
    const kpis = computeHealthKpis(events, []);
    expect(kpis.runs).toBe(1);
    expect(kpis.merged).toBe(1);
  });
});
