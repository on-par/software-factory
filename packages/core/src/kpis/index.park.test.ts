import { describe, expect, it } from 'vitest';

import type { FactoryEvent } from '../types/index.js';
import { computeHealthKpis, formatKpiLines, renderKpiReport } from './index.js';

function event(overrides: Partial<FactoryEvent> = {}): FactoryEvent {
  return { ts: '2026-07-20T00:00:00.000Z', type: 'issue-title', issue: '1', msg: '', ...overrides };
}

const hr = (h: number) => new Date(Date.UTC(2026, 6, 20, h)).toISOString();
const HOUR = 3_600_000;

describe('park KPIs (#3513)', () => {
  it('reports open parked 3 and median park-to-human 2h', () => {
    const events = [
      event({ issue: '1', ts: hr(0) }),
      event({ issue: '1', type: 'parked', ts: hr(0) }),
      event({ issue: '1', type: 'human-edited', ts: hr(1) }),
      event({ issue: '2', ts: hr(0) }),
      event({ issue: '2', type: 'parked', ts: hr(0) }),
      event({ issue: '2', type: 'issue_unparked', ts: hr(2) }),
      event({ issue: '3', ts: hr(0) }),
      event({ issue: '3', type: 'parked', ts: hr(0) }),
      event({ issue: '4', ts: hr(0) }),
      event({ issue: '4', type: 'parked', ts: hr(0) }),
      event({ issue: '4', type: 'human-approved', ts: hr(3) }),
      event({ issue: '4', type: 'merged', ts: hr(4) }),
      event({ issue: '5', ts: hr(0) }),
      event({ issue: '5', type: 'merged', ts: hr(1) }),
    ];
    const kpis = computeHealthKpis(events, []);
    expect(kpis.openParked).toBe(3);
    expect(kpis.parkToHumanSamples).toBe(3);
    expect(kpis.medianParkToHumanMs).toBe(2 * HOUR);
    for (const lines of [formatKpiLines(kpis), renderKpiReport(kpis)]) {
      const text = Array.isArray(lines) ? lines.join('\n') : lines;
      expect(text).toContain('Open parked: 3');
      expect(text).toContain('Park-to-human (median): 2h 0m (3 parks answered)');
    }
  });

  it('reports 0 open parked and n/a median when nothing parked', () => {
    const kpis = computeHealthKpis(
      [event({ issue: '1' }), event({ issue: '1', type: 'merged' }), event({ issue: '2' })],
      [],
    );
    expect(kpis.openParked).toBe(0);
    expect(kpis.medianParkToHumanMs).toBeNull();
    expect(kpis.parkToHumanSamples).toBe(0);
    const lines = formatKpiLines(kpis);
    expect(lines).toContain('Open parked: 0');
    expect(lines).toContain('Park-to-human (median): n/a (0 parks answered)');
  });

  it('measures from the earliest unanswered park and ignores events before the park', () => {
    const kpis = computeHealthKpis(
      [
        event({ type: 'human-edited', ts: hr(0) }),
        event({ type: 'parked', ts: hr(1) }),
        event({ type: 'timeout', ts: hr(2) }),
        event({ type: 'human-approved', ts: hr(4) }),
      ],
      [],
    );
    expect(kpis.parkToHumanSamples).toBe(1);
    expect(kpis.medianParkToHumanMs).toBe(3 * HOUR);
  });

  it('orders events by timestamp, not log position', () => {
    const kpis = computeHealthKpis(
      [event({ type: 'human-approved', ts: hr(2) }), event({ type: 'parked', ts: hr(0) })],
      [],
    );
    expect(kpis.parkToHumanSamples).toBe(1);
    expect(kpis.medianParkToHumanMs).toBe(2 * HOUR);
  });
});
