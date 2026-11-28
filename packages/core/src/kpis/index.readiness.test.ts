import { describe, expect, it } from 'vitest';

import type { EscalateKind, FactoryEvent, ReadinessInfo } from '../types/index.js';
import { computeHealthKpis } from './index.js';

type Verdict = NonNullable<ReadinessInfo['judge']>['verdict'];

function event(overrides: Partial<FactoryEvent> = {}): FactoryEvent {
  return { ts: '2026-07-20T00:00:00.000Z', type: 'issue-title', issue: '1', msg: '', ...overrides };
}

function judged(issue: string, verdict: Verdict): FactoryEvent {
  return event({
    issue,
    type: 'readiness',
    phase: 'plan',
    readiness: {
      template: 'factory-task',
      score: 1,
      pass: true,
      missing: [],
      judge: { verdict, questions: [], assumptions: [], aspects: [], cached: false, model: 'm', promptVersion: 'v1' },
    },
  });
}

function planEscalate(issue: string, escalateKind?: EscalateKind): FactoryEvent {
  return event({ issue, type: 'escalate', phase: 'plan', ...(escalateKind ? { escalateKind } : {}) });
}

describe('readiness verdict KPIs (#3470)', () => {
  it('counts one run per verdict and a 1/3 not-ready park rate', () => {
    const kpis = computeHealthKpis(
      [
        judged('1', 'ready'),
        event({ issue: '1', type: 'merged' }),
        judged('2', 'ready-with-assumptions'),
        event({ issue: '2', type: 'merged' }),
        judged('3', 'not-ready'),
        event({ issue: '3', type: 'not-ready' }),
      ],
      [],
    );
    expect(kpis.readinessVerdicts).toEqual({ ready: 1, withAssumptions: 1, notReady: 1 });
    expect(kpis.notReadyParkRate).toBeCloseTo(1 / 3);
    expect(kpis.lateNotReadyRuns).toBe(0);
  });

  it('reports zero verdicts and a zero park rate when nothing ran', () => {
    const kpis = computeHealthKpis([], []);
    expect(kpis.readinessVerdicts).toEqual({ ready: 0, withAssumptions: 0, notReady: 0 });
    expect(kpis.notReadyParkRate).toBe(0);
    expect(kpis.lateNotReadyRuns).toBe(0);
  });

  it('ignores heading-only readiness events and non-ticket issues', () => {
    const kpis = computeHealthKpis(
      [
        event({ type: 'readiness', readiness: { template: 'factory-task', score: 1, pass: true, missing: [] } }),
        judged('all', 'ready'),
        event({ issue: '-', type: 'not-ready' }),
      ],
      [],
    );
    expect(kpis.runs).toBe(1);
    expect(kpis.readinessVerdicts).toEqual({ ready: 0, withAssumptions: 0, notReady: 0 });
    expect(kpis.notReadyParkRate).toBe(0);
  });

  it('uses the latest verdict of a run and counts a repeated not-ready park once', () => {
    const kpis = computeHealthKpis(
      [
        judged('1', 'not-ready'),
        event({ issue: '1', type: 'not-ready' }),
        judged('1', 'not-ready'),
        event({ issue: '1', type: 'not-ready' }),
        judged('1', 'ready'),
        event({ issue: '1', type: 'merged' }),
        judged('2', 'ready'),
      ],
      [],
    );
    expect(kpis.readinessVerdicts).toEqual({ ready: 2, withAssumptions: 0, notReady: 0 });
    expect(kpis.notReadyParkRate).toBe(0.5);
  });

  it('counts a late not-ready run only when a ready verdict precedes a missing-info or contradiction PLAN escalate', () => {
    const kpis = computeHealthKpis(
      [
        judged('1', 'ready'),
        planEscalate('1', 'missing-info'),
        judged('2', 'ready-with-assumptions'),
        planEscalate('2', 'contradiction'),
        planEscalate('2', 'missing-info'),
        judged('3', 'ready'),
        planEscalate('3', 'split'),
        judged('4', 'not-ready'),
        planEscalate('4', 'missing-info'),
        planEscalate('5', 'missing-info'),
        judged('5', 'ready'),
        judged('6', 'ready'),
        planEscalate('6'),
        judged('7', 'ready'),
        event({ issue: '7', type: 'escalate', phase: 'build', escalateKind: 'missing-info' }),
      ],
      [],
    );
    expect(kpis.lateNotReadyRuns).toBe(2);
    expect(kpis.readinessVerdicts).toEqual({ ready: 5, withAssumptions: 1, notReady: 1 });
  });
});
