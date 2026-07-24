import { describe, expect, it } from 'vitest';

import type { CostEntry, FactoryEvent } from '../types/index.js';
import {
  appendKpiHistoryLine,
  computeHealthKpis,
  formatKpiLines,
  type KpiHistoryRecord,
  kpisToHistoryRecord,
  parseKpiHistory,
  renderKpiReport,
  renderKpiTrend,
} from './index.js';

function event(overrides: Partial<FactoryEvent> = {}): FactoryEvent {
  return {
    ts: '2026-07-20T00:00:00.000Z',
    type: 'issue-title',
    issue: '1',
    msg: '',
    ...overrides,
  };
}

const at = (sec: number) => new Date(Date.UTC(2026, 6, 20, 0, 0, sec)).toISOString();

function cost(overrides: Partial<CostEntry> = {}): CostEntry {
  return {
    ts: '2026-07-20T00:00:00.000Z',
    issue: '1',
    task: 'build',
    model: 'stub-model',
    inputTokens: 0,
    outputTokens: 0,
    cost: 0,
    ...overrides,
  };
}

describe('computeHealthKpis', () => {
  it('computes rates from the event log', () => {
    const events: FactoryEvent[] = [
      event({ issue: '1', type: 'issue-title' }),
      event({ issue: '1', type: 'merged' }),
      event({ issue: '2', type: 'issue-title' }),
      event({ issue: '2', type: 'rework' }),
      event({ issue: '2', type: 'merged' }),
      event({ issue: '3', type: 'issue-title' }),
      event({ issue: '3', type: 'parked' }),
      event({ issue: '4', type: 'issue-title' }),
    ];

    const kpis = computeHealthKpis(events, []);

    expect(kpis.runs).toBe(4);
    expect(kpis.merged).toBe(2);
    expect(kpis.reworkRuns).toBe(1);
    expect(kpis.stuckRuns).toBe(0);
    expect(kpis.interventionRuns).toBe(1);
    expect(kpis.mergeRate).toBe(0.5);
    expect(kpis.reworkRate).toBe(0.25);
    expect(kpis.stuckRate).toBe(0);
    expect(kpis.humanInterventionRate).toBe(0.25);
  });

  it('detects stuck runs via type: stuck and via rework.stuck', () => {
    const events: FactoryEvent[] = [
      event({ issue: '1', type: 'stuck' }),
      event({
        issue: '2',
        type: 'rework',
        rework: { round: 2, failingChecks: ['tests'], cause: 'factory-fault', stuck: true },
      }),
      event({ issue: '3', type: 'rework', rework: { round: 1, failingChecks: ['lint'], cause: 'factory-fault' } }),
    ];

    const kpis = computeHealthKpis(events, []);

    expect(kpis.stuckRuns).toBe(2);
    expect(kpis.reworkRuns).toBe(2);
  });

  it('excludes sentinel issue ids from runs', () => {
    const events: FactoryEvent[] = [
      event({ issue: '-', type: 'issue-title' }),
      event({ issue: 'all', type: 'merged' }),
      event({ issue: '1', type: 'issue-title' }),
    ];

    const kpis = computeHealthKpis(events, []);

    expect(kpis.runs).toBe(1);
  });

  it('computes cost per merged PR', () => {
    const events: FactoryEvent[] = [
      event({ issue: '1', type: 'issue-title' }),
      event({ issue: '1', type: 'merged' }),
      event({ issue: '2', type: 'issue-title' }),
      event({ issue: '2', type: 'merged' }),
    ];
    const costs: CostEntry[] = [cost({ issue: '1', cost: 0.3 }), cost({ issue: '2', cost: 0.5 })];

    const kpis = computeHealthKpis(events, costs);

    expect(kpis.totalCost).toBeCloseTo(0.8);
    expect(kpis.costPerMergedPr).toBeCloseTo(0.4);
  });

  it('yields null cost per merged PR and "n/a" formatting when nothing merged', () => {
    const events: FactoryEvent[] = [event({ issue: '1', type: 'issue-title' })];
    const costs: CostEntry[] = [cost({ issue: '1', cost: 1.2 })];

    const kpis = computeHealthKpis(events, costs);

    expect(kpis.merged).toBe(0);
    expect(kpis.costPerMergedPr).toBeNull();
    expect(formatKpiLines(kpis)).toContain('Cost per merged PR: n/a');
  });

  it('returns all-zero rates and a null cost with zero runs, and never emits NaN', () => {
    const kpis = computeHealthKpis([], []);

    expect(kpis.runs).toBe(0);
    expect(kpis.mergeRate).toBe(0);
    expect(kpis.reworkRate).toBe(0);
    expect(kpis.stuckRate).toBe(0);
    expect(kpis.humanInterventionRate).toBe(0);
    expect(kpis.costPerMergedPr).toBeNull();
    expect(kpis.medianCycleTimeMs).toBeNull();
    expect(kpis.p90CycleTimeMs).toBeNull();
    expect(kpis.queueWaitMs).toBeNull();
    expect(kpis.phaseDurations).toEqual({});
    expect(kpis.cycleTimeExcludedRuns).toBe(0);

    const lines = formatKpiLines(kpis);
    expect(lines).toEqual(['No factory runs recorded yet.']);
    expect(lines.join('\n')).not.toContain('NaN');
  });
});

describe('cycle time KPIs', () => {
  it('computes cycle time, phase durations, and queue wait for a single run', () => {
    const events: FactoryEvent[] = [
      event({ issue: '1', type: 'issue-title', ts: at(0) }),
      event({ issue: '1', type: 'phase-start', phase: 'plan', ts: at(5) }),
      event({ issue: '1', type: 'phase-end', phase: 'plan', ts: at(65) }),
      event({ issue: '1', type: 'phase-start', phase: 'build', ts: at(65) }),
      event({ issue: '1', type: 'phase-end', phase: 'build', ts: at(365) }),
      event({ issue: '1', type: 'merged', ts: at(400) }),
    ];

    const kpis = computeHealthKpis(events, []);

    expect(kpis.medianCycleTimeMs).toBe(400_000);
    expect(kpis.p90CycleTimeMs).toBe(400_000);
    expect(kpis.queueWaitMs).toBe(5_000);
    expect(kpis.phaseDurations).toEqual({ plan: 60_000, build: 300_000 });
    expect(kpis.cycleTimeExcludedRuns).toBe(0);
  });

  it('excludes runs with no terminal merge event from cycle stats', () => {
    const events: FactoryEvent[] = [
      event({ issue: '1', type: 'issue-title', ts: at(0) }),
      event({ issue: '1', type: 'merged', ts: at(400) }),
      event({ issue: '2', type: 'issue-title', ts: at(0) }),
      event({ issue: '2', type: 'stuck', ts: at(10) }),
    ];

    const kpis = computeHealthKpis(events, []);

    expect(kpis.medianCycleTimeMs).toBe(400_000);
    expect(kpis.p90CycleTimeMs).toBe(400_000);
    expect(kpis.cycleTimeExcludedRuns).toBe(1);
    expect(formatKpiLines(kpis).join('\n')).toContain('1 excluded: no terminal event');
  });

  it('computes p90 with linear interpolation across more than 10 runs', () => {
    const events: FactoryEvent[] = [];
    for (let k = 1; k <= 11; k++) {
      const issue = String(k);
      events.push(event({ issue, type: 'issue-title', ts: at(0) }));
      events.push(event({ issue, type: 'merged', ts: new Date(Date.UTC(2026, 6, 20, 0, k, 0)).toISOString() }));
    }

    const kpis = computeHealthKpis(events, []);

    expect(kpis.medianCycleTimeMs).toBe(6 * 60_000);
    expect(kpis.p90CycleTimeMs).toBe(10 * 60_000);
  });

  it('formats cycle time, phase medians, and queue wait lines, including hour-scale durations', () => {
    const events: FactoryEvent[] = [
      event({ issue: '1', type: 'issue-title', ts: at(0) }),
      event({ issue: '1', type: 'phase-start', phase: 'plan', ts: at(5) }),
      event({ issue: '1', type: 'phase-end', phase: 'plan', ts: at(65) }),
      event({ issue: '1', type: 'merged', ts: new Date(Date.UTC(2026, 6, 20, 2, 0, 0)).toISOString() }),
    ];

    const kpis = computeHealthKpis(events, []);
    const lines = formatKpiLines(kpis);

    expect(lines.join('\n')).toContain('h ');
    expect(lines).toContain('Phase medians: plan 1m 0s');
    expect(lines).toContain('Queue wait (median): 5s');

    const trendKpis = computeHealthKpis(
      [
        event({ issue: '10', type: 'issue-title', ts: at(0) }),
        event({ issue: '10', type: 'merged', ts: new Date(Date.UTC(2026, 6, 20, 0, 6, 0)).toISOString() }),
        event({ issue: '11', type: 'issue-title', ts: at(0) }),
        event({ issue: '11', type: 'merged', ts: new Date(Date.UTC(2026, 6, 20, 0, 10, 0)).toISOString() }),
      ],
      [],
    );
    expect(formatKpiLines(trendKpis)).toContain(
      'Cycle time (issue→merge): median 8m 0s, p90 9m 36s (2 merged, 0 excluded: no terminal event)',
    );
    expect(renderKpiReport(trendKpis)).toContain('## Health KPIs');
  });
});

describe('renderKpiReport', () => {
  it('renders a markdown block with the Health KPIs heading', () => {
    const kpis = computeHealthKpis(
      [event({ issue: '1', type: 'issue-title' }), event({ issue: '1', type: 'merged' })],
      [],
    );

    const report = renderKpiReport(kpis);

    expect(report).toContain('## Health KPIs');
    expect(report).toContain('Merge rate: 100% (1/1)');
    expect(report.endsWith('\n')).toBe(true);
  });
});

describe('KPI trend', () => {
  function historyRecord(overrides: Partial<KpiHistoryRecord> = {}): KpiHistoryRecord {
    return {
      date: '2026-07-18',
      runs: 4,
      mergeRate: 0.5,
      reworkRate: 0.25,
      stuckRate: 0,
      humanInterventionRate: 0.25,
      costPerMergedPr: 0.4,
      medianCycleTimeMs: 360_000,
      p90CycleTimeMs: 600_000,
      ...overrides,
    };
  }

  it('round-trips records through append/parse and renders a trend table', () => {
    const records = [
      historyRecord({ date: '2026-07-18' }),
      historyRecord({ date: '2026-07-19', runs: 5, costPerMergedPr: null }),
      historyRecord({ date: '2026-07-20', runs: 6 }),
    ];

    let jsonl = '';
    for (const record of records) {
      jsonl = appendKpiHistoryLine(jsonl, record);
    }

    const parsed = parseKpiHistory(jsonl);
    expect(parsed).toEqual(records);

    const trend = renderKpiTrend(parsed);
    expect(trend).toContain('## Health KPI trend');
    expect(trend).toContain('| date | runs | merge | rework | stuck | human | $/merged | cycle p50 | cycle p90 |');
    for (const record of records) {
      expect(trend).toContain(record.date);
    }
    expect(trend).toContain('—');
  });

  it('reports no history when empty', () => {
    const trend = renderKpiTrend([]);
    expect(trend).toContain('## Health KPI trend');
    expect(trend).toContain('No KPI history yet.');
  });

  it('renders legacy records without cycle-time fields as em-dash cells', () => {
    const legacy = {
      date: '2026-07-17',
      runs: 3,
      mergeRate: 1,
      reworkRate: 0,
      stuckRate: 0,
      humanInterventionRate: 0,
      costPerMergedPr: null,
    } as KpiHistoryRecord;

    const trend = renderKpiTrend([legacy]);
    const row = trend.split('\n').find((line) => line.startsWith('| 2026-07-17'));
    expect(row).toBeDefined();
    expect(row).toBe('| 2026-07-17 | 3 | 100% | 0% | 0% | 0% | — | — | — |');
  });

  it('builds a history record from computed KPIs', () => {
    const kpis = computeHealthKpis(
      [event({ issue: '1', type: 'issue-title' }), event({ issue: '1', type: 'merged' })],
      [],
    );
    const record = kpisToHistoryRecord(kpis, '2026-07-20');
    expect(record).toEqual({
      date: '2026-07-20',
      runs: 1,
      mergeRate: 1,
      reworkRate: 0,
      stuckRate: 0,
      humanInterventionRate: 0,
      costPerMergedPr: 0,
      medianCycleTimeMs: 0,
      p90CycleTimeMs: 0,
    });
  });
});
