import { describe, expect, it } from 'vitest';

import type { CostEntry, FactoryEvent } from '../types/index.js';
import {
  appendKpiHistoryLine,
  computeHealthKpis,
  computeKpiDrift,
  costRouteOf,
  formatKpiLines,
  KPI_DRIFT_THRESHOLD_RATIO,
  KPI_DRIFT_WINDOW_SIZE,
  type KpiHistoryRecord,
  kpisToHistoryRecord,
  parseKpiHistory,
  renderKpiDriftLine,
  renderKpiReport,
  renderKpiTrend,
  retryCauseOf,
  reworkCauseTagOf,
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
    expect(kpis.mergeRate).toBe(0.5);
    expect(kpis.reworkRate).toBe(0.25);
    expect(kpis.stuckRate).toBe(0);
    // 'parked' is a proxy event, not an explicit human-* event — the human
    // metric is built solely from human-* events now (#420).
    expect(kpis.humanTouchedRuns).toBe(0);
    expect(kpis.humanInterventionRate).toBe(0);
  });

  it('counts an explicit human-* event toward humanTouchedRuns', () => {
    const events: FactoryEvent[] = [
      event({ issue: '1', type: 'issue-title' }),
      event({ issue: '1', type: 'human-approved', actor: 'alice' }),
      event({ issue: '1', type: 'merged' }),
      event({ issue: '2', type: 'issue-title' }),
      event({ issue: '2', type: 'merged' }),
    ];

    const kpis = computeHealthKpis(events, []);

    expect(kpis.humanTouchedRuns).toBe(1);
    expect(kpis.humanInterventionRate).toBe(0.5);
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

  it('counts a timeout park that also emits an explicit stuck event, and attributes it to the timed-out run', () => {
    const events: FactoryEvent[] = [
      event({ issue: '1', type: 'issue-title' }),
      event({ issue: '1', type: 'merged' }),
      event({ issue: '2', type: 'issue-title' }),
      event({ issue: '2', type: 'timeout', msg: 'build timed out after 3600s' }),
      event({
        issue: '2',
        type: 'stuck',
        msg: 'run exceeded its phase timeout without progressing — build timed out after 3600s',
      }),
    ];

    const kpis = computeHealthKpis(events, []);

    expect(kpis.stuckRuns).toBe(1);
    expect(kpis.stuckRate).toBe(0.5);
    expect(kpis.merged).toBe(1);
  });

  it('reports a true zero stuckRate when every run reaches a terminal state within its timeout', () => {
    const events: FactoryEvent[] = [
      event({ issue: '1', type: 'issue-title' }),
      event({ issue: '1', type: 'merged' }),
      event({ issue: '2', type: 'issue-title' }),
      event({ issue: '2', type: 'merged' }),
    ];

    const kpis = computeHealthKpis(events, []);

    expect(kpis.stuckRuns).toBe(0);
    expect(kpis.stuckRate).toBe(0);
    expect(kpis.totalRetries).toBe(0);
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
    expect(formatKpiLines(kpis)).toContain(
      'Cost per merged PR: unknown (cost coverage 100%: 1/1 invocations with a cost row)',
    );
  });

  it('returns all-zero rates and a null cost with zero runs, and never emits NaN', () => {
    const kpis = computeHealthKpis([], []);

    expect(kpis.runs).toBe(0);
    expect(kpis.mergeRate).toBe(0);
    expect(kpis.reworkRate).toBe(0);
    expect(kpis.stuckRate).toBe(0);
    expect(kpis.humanInterventionRate).toBe(0);
    expect(kpis.humanEventsPerRun).toBeNull();
    expect(kpis.fullyAutonomousRate).toBe(0);
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

describe('human intervention KPIs (#420)', () => {
  it('a human-pushed commit makes a merged run non-autonomous, a clean run stays autonomous', () => {
    const events: FactoryEvent[] = [
      event({ issue: '1', type: 'issue-title' }),
      event({ issue: '1', type: 'human-edited', actor: 'alice' }),
      event({ issue: '1', type: 'merged' }),
      event({ issue: '2', type: 'issue-title' }),
      event({ issue: '2', type: 'merged' }),
    ];

    const kpis = computeHealthKpis(events, []);

    expect(kpis.merged).toBe(2);
    expect(kpis.humanTouchedRuns).toBe(1);
    expect(kpis.fullyAutonomousRuns).toBe(1);
    expect(kpis.fullyAutonomousRate).toBe(0.5);
  });

  it('a human-merged event counts the run as merged but not autonomous', () => {
    const events: FactoryEvent[] = [
      event({ issue: '1', type: 'issue-title' }),
      event({ issue: '1', type: 'human-merged', actor: 'bob' }),
    ];

    const kpis = computeHealthKpis(events, []);

    expect(kpis.merged).toBe(1);
    expect(kpis.mergeRate).toBe(1);
    expect(kpis.humanTouchedRuns).toBe(1);
    expect(kpis.fullyAutonomousRuns).toBe(0);
  });

  it('computes humanEventsPerRun as the mean human events across all runs', () => {
    const events: FactoryEvent[] = [
      event({ issue: '1', type: 'issue-title' }),
      event({ issue: '1', type: 'human-approved', actor: 'alice' }),
      event({ issue: '1', type: 'human-edited', actor: 'alice' }),
      event({ issue: '2', type: 'issue-title' }),
      event({ issue: '2', type: 'human-approved', actor: 'bob' }),
    ];

    const kpis = computeHealthKpis(events, []);

    expect(kpis.humanEventsPerRun).toBe(1.5);
  });

  it('includes the human-touched and fully-autonomous lines in formatKpiLines', () => {
    const events: FactoryEvent[] = [
      event({ issue: '1', type: 'issue-title' }),
      event({ issue: '1', type: 'human-approved', actor: 'alice' }),
      event({ issue: '1', type: 'merged' }),
      event({ issue: '2', type: 'issue-title' }),
      event({ issue: '2', type: 'merged' }),
    ];

    const kpis = computeHealthKpis(events, []);
    const lines = formatKpiLines(kpis);

    expect(lines).toContain('Human-touched runs: 50% (1/2, 0.50 human events/run)');
    expect(lines).toContain('Fully autonomous: 50% (1/2 merged with zero human events)');
  });

  it('formats a null humanEventsPerRun as n/a instead of crashing (defensive: HealthKpis is public API)', () => {
    const kpis = computeHealthKpis(
      [event({ issue: '1', type: 'issue-title' }), event({ issue: '1', type: 'merged' })],
      [],
    );

    const lines = formatKpiLines({ ...kpis, humanEventsPerRun: null });

    expect(lines).toContain('Human-touched runs: 0% (0/1, n/a human events/run)');
  });
});

describe('cycle time KPIs', () => {
  it('computes cycle time, phase durations, and queue wait for a single run', () => {
    const events: FactoryEvent[] = [
      event({ issue: '1', type: 'issue-title', ts: at(0) }),
      event({ issue: '1', type: 'build', phase: 'plan', ts: at(5) }),
      event({ issue: '1', type: 'ship', phase: 'plan', ts: at(65) }),
      event({ issue: '1', type: 'build', phase: 'build', ts: at(65) }),
      event({ issue: '1', type: 'ship', phase: 'build', ts: at(365) }),
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
      event({ issue: '1', type: 'build', phase: 'plan', ts: at(5) }),
      event({ issue: '1', type: 'ship', phase: 'plan', ts: at(65) }),
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

describe('retryCauseOf', () => {
  it('classifies rework events as checker retries', () => {
    expect(retryCauseOf(event({ type: 'rework' }))).toBe('checker');
  });

  it('classifies timeout failovers', () => {
    expect(retryCauseOf(event({ type: 'failover', failoverReason: 'timeout' }))).toBe('timeout');
  });

  it('classifies unknown failovers as other', () => {
    expect(retryCauseOf(event({ type: 'failover', failoverReason: 'unknown' }))).toBe('other');
  });

  it('classifies any other failoverReason as failover', () => {
    expect(retryCauseOf(event({ type: 'failover', failoverReason: 'rate_limit' }))).toBe('failover');
  });

  it('returns null for a plain, non-retry event', () => {
    expect(retryCauseOf(event({ type: 'issue-title' }))).toBeNull();
  });
});

describe('reworkCauseTagOf (#615)', () => {
  it('tags a conflict event (branch collided with a file another lane had already merged) as merge-conflict', () => {
    expect(reworkCauseTagOf(event({ type: 'conflict', msg: 'rebase conflict on the-branch — parked' }))).toBe(
      'merge-conflict',
    );
  });

  it('tags a rework event with failing checkers as checker-failure', () => {
    expect(
      reworkCauseTagOf(
        event({ type: 'rework', rework: { round: 1, failingChecks: ['tests'], cause: 'factory-fault' } }),
      ),
    ).toBe('checker-failure');
  });

  it('tags a stuck event with failing checkers as checker-failure', () => {
    expect(
      reworkCauseTagOf(
        event({
          type: 'stuck',
          rework: { round: 2, failingChecks: ['lint'], cause: 'factory-fault', stuck: true },
        }),
      ),
    ).toBe('checker-failure');
  });

  it('tags a rework event with no failing checkers recorded as other', () => {
    expect(
      reworkCauseTagOf(event({ type: 'rework', rework: { round: 1, failingChecks: [], cause: 'factory-fault' } })),
    ).toBe('other');
  });

  it('returns null for a plain, non-rework event', () => {
    expect(reworkCauseTagOf(event({ type: 'issue-title' }))).toBeNull();
  });
});

describe('retry KPIs', () => {
  it('buckets each retry cause and sums totalRetries', () => {
    const events: FactoryEvent[] = [
      event({ issue: '1', type: 'issue-title' }),
      event({ issue: '1', type: 'rework', rework: { round: 1, failingChecks: ['tests'], cause: 'factory-fault' } }),
      event({ issue: '1', type: 'failover', failoverReason: 'timeout' }),
      event({ issue: '1', type: 'failover', failoverReason: 'rate_limit' }),
      event({ issue: '1', type: 'failover', failoverReason: 'unknown' }),
    ];

    const kpis = computeHealthKpis(events, []);

    expect(kpis.retriesByCause).toEqual({ checker: 1, timeout: 1, failover: 1, other: 1 });
    expect(kpis.totalRetries).toBe(4);
  });

  it('does not double-count a stuck event carrying a rework payload', () => {
    const events: FactoryEvent[] = [
      event({ issue: '1', type: 'issue-title' }),
      event({
        issue: '1',
        type: 'stuck',
        rework: { round: 2, failingChecks: ['tests'], cause: 'factory-fault', stuck: true },
      }),
    ];

    const kpis = computeHealthKpis(events, []);

    expect(kpis.totalRetries).toBe(0);
    expect(kpis.retriesByCause).toEqual({ checker: 0, timeout: 0, failover: 0, other: 0 });
  });

  it('reports zero retries and zero cost share for a clean merged run', () => {
    const events: FactoryEvent[] = [event({ issue: '1', type: 'issue-title' }), event({ issue: '1', type: 'merged' })];

    const kpis = computeHealthKpis(events, []);

    expect(kpis.totalRetries).toBe(0);
    expect(kpis.retriesPerRun).toBe(0);
    expect(kpis.retriesByCause).toEqual({ checker: 0, timeout: 0, failover: 0, other: 0 });
    expect(kpis.retryCostShare).toBe(0);

    const lines = formatKpiLines(kpis);
    expect(lines).toContain('Retries: total 0, median 0/run (checker 0 · failover 0 · timeout 0 · other 0)');
    expect(lines).toContain('Retry cost share: 0% of total spend (cost coverage: unknown — no cost rows recorded)');
  });

  it('yields a null median retries per run for an empty log', () => {
    const kpis = computeHealthKpis([], []);
    expect(kpis.retriesPerRun).toBeNull();
    expect(formatKpiLines(kpis)).toEqual(['No factory runs recorded yet.']);
  });

  it('computes the median retries per run across zero- and multi-retry runs', () => {
    const events: FactoryEvent[] = [
      event({ issue: '1', type: 'issue-title' }),
      event({ issue: '2', type: 'issue-title' }),
      event({ issue: '2', type: 'rework', rework: { round: 1, failingChecks: ['tests'], cause: 'factory-fault' } }),
      event({ issue: '2', type: 'rework', rework: { round: 2, failingChecks: ['tests'], cause: 'factory-fault' } }),
    ];

    const kpis = computeHealthKpis(events, []);

    expect(kpis.retriesPerRun).toBe(1);
    expect(kpis.totalRetries).toBe(2);
  });

  it('computes retryCostShare from tagged cost rows, counting dual-tagged rows once', () => {
    const costs: CostEntry[] = [
      cost({ cost: 0.5 }),
      cost({ cost: 0.3, retryCause: 'checker' }),
      cost({ cost: 0.2, failoverReason: 'rate_limit' }),
    ];

    const kpis = computeHealthKpis([event({ issue: '1', type: 'issue-title' })], costs);

    expect(kpis.retryCostShare).toBeCloseTo(0.5);
  });

  it('yields a zero retryCostShare when totalCost is zero', () => {
    const kpis = computeHealthKpis([event({ issue: '1', type: 'issue-title' })], []);
    expect(kpis.retryCostShare).toBe(0);
  });
});

describe('phase-level cost and time attribution (#614)', () => {
  it('attributes cost per phase, mapping CHECK rework-repair cost via retryCause, not task', () => {
    const costs: CostEntry[] = [
      cost({ task: 'plan', cost: 0.1 }),
      cost({ task: 'build_claude', cost: 0.5 }),
      // CHECK's rework-repair call reuses the build_claude task but is tagged
      // retryCause: 'checker' — that must win over the task-based mapping.
      cost({ task: 'build_claude', cost: 0.2, retryCause: 'checker' }),
      cost({ task: 'check_tests', cost: 0.05 }),
      cost({ task: 'review_pr', cost: 0.02 }),
    ];

    const kpis = computeHealthKpis([event({ issue: '1', type: 'issue-title' })], costs);

    expect(kpis.phaseCosts).toEqual({ plan: 0.1, build: 0.5, check: 0.25, ship: 0.02 });
  });

  it('drops cost rows whose task has no known phase mapping', () => {
    const kpis = computeHealthKpis([event({ issue: '1', type: 'issue-title' })], [cost({ task: 'unmapped', cost: 1 })]);

    expect(kpis.phaseCosts).toEqual({});
  });

  it('runs a fixture pipeline through PLAN/BUILD/CHECK/SHIP with known synthetic durations and persists a snapshot whose per-phase entries sum to the total cycle time', () => {
    const events: FactoryEvent[] = [
      event({ issue: '1', type: 'issue-title', ts: at(0) }),
      event({ issue: '1', type: 'build', phase: 'plan', ts: at(0) }),
      event({ issue: '1', type: 'ship', phase: 'plan', ts: at(60) }),
      event({ issue: '1', type: 'build', phase: 'build', ts: at(60) }),
      event({ issue: '1', type: 'ship', phase: 'build', ts: at(360) }),
      event({ issue: '1', type: 'build', phase: 'check', ts: at(360) }),
      event({
        issue: '1',
        type: 'rework',
        ts: at(400),
        rework: { round: 1, failingChecks: ['tests'], cause: 'factory-fault' },
      }),
      event({ issue: '1', type: 'ship', phase: 'check', ts: at(420) }),
      event({ issue: '1', type: 'build', phase: 'ship', ts: at(420) }),
      event({ issue: '1', type: 'ship', phase: 'ship', ts: at(450) }),
      event({ issue: '1', type: 'merged', ts: at(450) }),
    ];
    const costs: CostEntry[] = [
      cost({ task: 'plan', cost: 0.1 }),
      cost({ task: 'build_claude', cost: 0.5 }),
      cost({ task: 'build_claude', cost: 0.2, retryCause: 'checker' }),
      cost({ task: 'check_tests', cost: 0.05 }),
      cost({ task: 'review_pr', cost: 0.02 }),
    ];

    const kpis = computeHealthKpis(events, costs);

    expect(kpis.phaseDurations).toEqual({ plan: 60_000, build: 300_000, check: 60_000, ship: 30_000 });
    expect(kpis.phaseCosts).toEqual({ plan: 0.1, build: 0.5, check: 0.25, ship: 0.02 });
    expect(kpis.retriesByCause).toEqual({ checker: 1, failover: 0, timeout: 0, other: 0 });
    expect(kpis.medianCycleTimeMs).toBe(450_000);

    const record = kpisToHistoryRecord(kpis, '2026-08-10');
    const jsonl = appendKpiHistoryLine('', record);
    const [snapshot] = parseKpiHistory(jsonl);

    for (const phase of ['plan', 'build', 'check', 'ship']) {
      expect(snapshot.phaseDurationsMs?.[phase]).toBeGreaterThan(0);
    }
    expect(snapshot.phaseCosts).toEqual({ plan: 0.1, build: 0.5, check: 0.25, ship: 0.02 });
    expect(snapshot.retriesByCause).toEqual({ checker: 1, failover: 0, timeout: 0, other: 0 });

    const summedPhaseDurations = Object.values(snapshot.phaseDurationsMs ?? {}).reduce((a, b) => a + b, 0);
    expect(summedPhaseDurations).toBe(snapshot.medianCycleTimeMs);
  });

  it('legacy history rows without phase attribution still parse', () => {
    const legacy: KpiHistoryRecord = {
      date: '2026-07-17',
      runs: 3,
      mergeRate: 1,
      reworkRate: 0,
      stuckRate: 0,
      humanInterventionRate: 0,
      fullyAutonomousRate: 0,
      costPerMergedPr: null,
      medianCycleTimeMs: null,
      p90CycleTimeMs: null,
    };

    const jsonl = appendKpiHistoryLine('', legacy);
    const [parsed] = parseKpiHistory(jsonl);

    expect(parsed.phaseDurationsMs).toBeUndefined();
    expect(parsed.phaseCosts).toBeUndefined();
    expect(parsed.retriesByCause).toBeUndefined();
    expect(parsed.medianCostPerMergedPr).toBeUndefined();
    expect(parsed.costScoredMergedRuns).toBeUndefined();
    expect(parsed.costRows).toBeUndefined();
    expect(parsed.costCoverage).toBeUndefined();
    expect(parsed.estimatedCostShare).toBeUndefined();
    expect(parsed.costByRoute).toBeUndefined();
    expect(() => renderKpiTrend([parsed])).not.toThrow();
  });
});

describe('cost aggregation and coverage (#426)', () => {
  it('reads no cost rows as unknown, not zero', () => {
    const events: FactoryEvent[] = [event({ issue: '1', type: 'issue-title' }), event({ issue: '1', type: 'merged' })];

    const kpis = computeHealthKpis(events, []);

    expect(kpis.costRows).toBe(0);
    expect(kpis.costPerMergedPr).toBeNull();
    expect(kpis.medianCostPerMergedPr).toBeNull();
    expect(kpis.costScoredMergedRuns).toBe(0);
    expect(kpis.estimatedCostShare).toBeNull();
    expect(kpis.costCoverage).toBeNull();
    expect(kpis.costByRoute).toEqual({});

    const lines = formatKpiLines(kpis);
    expect(lines).toContain('Cost per merged PR: unknown (cost coverage: unknown — no cost rows recorded)');
    expect(lines.join('\n')).not.toContain('$');
  });

  it('scores median and mean cost per merged PR over the merged cohort only, excluding a non-merged run', () => {
    const events: FactoryEvent[] = [
      event({ issue: '1', type: 'issue-title' }),
      event({ issue: '1', type: 'merged' }),
      event({ issue: '2', type: 'issue-title' }),
      event({ issue: '2', type: 'merged' }),
      event({ issue: '3', type: 'issue-title' }),
      event({ issue: '3', type: 'merged' }),
      event({ issue: '4', type: 'issue-title' }),
    ];
    const costs: CostEntry[] = [
      cost({ issue: '1', cost: 0.1 }),
      cost({ issue: '2', cost: 0.2 }),
      cost({ issue: '3', cost: 1.0 }),
      cost({ issue: '3', cost: 2.0 }),
      cost({ issue: '4', cost: 5.0 }),
    ];

    const kpis = computeHealthKpis(events, costs);

    expect(kpis.totalCost).toBeCloseTo(8.3);
    expect(kpis.costScoredMergedRuns).toBe(3);
    expect(kpis.costPerMergedPr).toBeCloseTo(1.1);
    expect(kpis.medianCostPerMergedPr).toBeCloseTo(0.2);
  });

  it('excludes a merged run with no cost row rather than counting it as free', () => {
    const events: FactoryEvent[] = [
      event({ issue: '1', type: 'issue-title' }),
      event({ issue: '1', type: 'merged' }),
      event({ issue: '2', type: 'issue-title' }),
      event({ issue: '2', type: 'merged' }),
    ];
    const costs: CostEntry[] = [cost({ issue: '1', cost: 0.4 })];

    const kpis = computeHealthKpis(events, costs);

    expect(kpis.merged).toBe(2);
    expect(kpis.costScoredMergedRuns).toBe(1);
    expect(kpis.costPerMergedPr).toBeCloseTo(0.4);
    expect(formatKpiLines(kpis).join('\n')).toContain('1/2 merged runs with cost rows');
  });

  it('computes partial coverage from cost rows plus failover events', () => {
    const events: FactoryEvent[] = [
      event({ issue: '1', type: 'issue-title' }),
      event({ issue: '1', type: 'failover', failoverReason: 'timeout' }),
      event({ issue: '1', type: 'failover', failoverReason: 'timeout' }),
    ];
    const costs: CostEntry[] = [
      cost({ issue: '1', cost: 0.1 }),
      cost({ issue: '1', cost: 0.2 }),
      cost({ issue: '1', cost: 0.3 }),
    ];

    const kpis = computeHealthKpis(events, costs);

    expect(kpis.observedInvocations).toBe(5);
    expect(kpis.costCoverage).toBeCloseTo(0.6);
    expect(formatKpiLines(kpis).join('\n')).toContain('(cost coverage 60%: 3/5 invocations with a cost row)');
  });

  it('does not double-count rework_model_failed alongside its failover event', () => {
    const events: FactoryEvent[] = [
      event({ issue: '1', type: 'issue-title' }),
      event({ issue: '1', type: 'failover', failoverReason: 'unavailable' }),
      event({ issue: '1', type: 'rework_model_failed', failoverReason: 'unavailable' }),
    ];
    const costs: CostEntry[] = [cost({ issue: '1', cost: 0.1 })];

    const kpis = computeHealthKpis(events, costs);

    expect(kpis.observedInvocations).toBe(2);
    expect(kpis.costCoverage).toBeCloseTo(0.5);
  });

  it('computes estimatedCostShare: all-estimated, mixed, and zero-cost-but-rows-exist', () => {
    const events: FactoryEvent[] = [event({ issue: '1', type: 'issue-title' })];

    const allEstimated = computeHealthKpis(events, [
      cost({ issue: '1', cost: 0.5, estimated: true }),
      cost({ issue: '1', cost: 0.5, estimated: true }),
    ]);
    expect(allEstimated.estimatedCostShare).toBe(1);
    expect(formatKpiLines(allEstimated).join('\n')).toContain('Estimated cost share: 100% of total spend');

    const mixed = computeHealthKpis(events, [
      cost({ issue: '1', cost: 0.25, estimated: true }),
      cost({ issue: '1', cost: 0.75, estimated: false }),
    ]);
    expect(mixed.estimatedCostShare).toBeCloseTo(0.25);

    const zeroCost = computeHealthKpis(events, [cost({ issue: '1', cost: 0, estimated: true })]);
    expect(zeroCost.estimatedCostShare).toBe(0);
  });

  it('splits spend into codex/claude/other buckets, task wins over model, and both phase and route lines print', () => {
    const events: FactoryEvent[] = [event({ issue: '1', type: 'issue-title' })];
    const costs: CostEntry[] = [
      cost({ issue: '1', task: 'build_codex', model: 'gpt-5.1-codex', cost: 10 }),
      cost({ issue: '1', task: 'build_claude', model: 'claude-opus-5', cost: 20 }),
      cost({ issue: '1', task: 'plan', model: 'claude-sonnet-5', cost: 30 }),
      cost({ issue: '1', task: 'check_tests', model: 'gpt-5.6-sol', cost: 40 }),
      cost({ issue: '1', task: 'plan', model: 'qwen3:8b', cost: 50 }),
    ];

    const kpis = computeHealthKpis(events, costs);

    expect(kpis.costByRoute).toEqual({ codex: 50, claude: 50, other: 50 });
    expect(Object.keys(kpis.costByRoute)).toEqual(['codex', 'claude', 'other']);

    const lines = formatKpiLines(kpis).join('\n');
    expect(lines).toContain('Cost by phase:');
    expect(lines).toContain('Cost by route:');
  });

  it('costRouteOf: task mapping wins over model family, then model-family prefix rules apply', () => {
    expect(costRouteOf(cost({ task: 'build_codex', model: 'claude-opus-5' }))).toBe('codex');
    expect(costRouteOf(cost({ task: 'build_claude', model: 'gpt-5.1-codex' }))).toBe('claude');
    expect(costRouteOf(cost({ task: 'plan', model: 'gpt-4.1-mini' }))).toBe('codex');
    expect(costRouteOf(cost({ task: 'plan', model: 'codex-ollama-qwen3.5:9b' }))).toBe('codex');
    expect(costRouteOf(cost({ task: 'plan', model: 'qwen3:8b' }))).toBe('other');
    expect(costRouteOf(cost({ task: 'plan', model: 'claude-fable-5' }))).toBe('claude');
  });

  it('round-trips the new cost fields through kpi-history, and a legacy row still parses with them undefined', () => {
    const events: FactoryEvent[] = [event({ issue: '1', type: 'issue-title' }), event({ issue: '1', type: 'merged' })];
    const costs: CostEntry[] = [
      cost({ issue: '1', task: 'build_codex', model: 'gpt-5.1-codex', cost: 0.3, estimated: true }),
      cost({ issue: '1', task: 'build_claude', model: 'claude-opus-5', cost: 0.7 }),
    ];
    const kpis = computeHealthKpis(events, costs);

    const record = kpisToHistoryRecord(kpis, '2026-08-12');
    const jsonl = appendKpiHistoryLine('', record);
    const [snapshot] = parseKpiHistory(jsonl);

    expect(snapshot.medianCostPerMergedPr).toBeCloseTo(kpis.medianCostPerMergedPr!);
    expect(snapshot.costScoredMergedRuns).toBe(kpis.costScoredMergedRuns);
    expect(snapshot.costRows).toBe(kpis.costRows);
    expect(snapshot.costCoverage).toBeCloseTo(kpis.costCoverage!);
    expect(snapshot.estimatedCostShare).toBeCloseTo(kpis.estimatedCostShare!);
    expect(snapshot.costByRoute).toEqual(kpis.costByRoute);
  });
});

describe('issue readiness KPIs (#421)', () => {
  const readyEvents: FactoryEvent[] = [
    event({ issue: '1', type: 'issue-title', ts: at(0) }),
    event({
      issue: '1',
      type: 'readiness',
      ts: at(1),
      readiness: { template: 'factory-task', score: 1, pass: true, missing: [] },
    }),
    event({ issue: '1', type: 'rework', ts: at(2) }),
    event({ issue: '1', type: 'merged', ts: at(10) }),
    event({ issue: '2', type: 'issue-title', ts: at(0) }),
    event({
      issue: '2',
      type: 'readiness',
      ts: at(1),
      readiness: { template: 'factory-task', score: 0.4, pass: false, missing: ['Verification'] },
    }),
    event({ issue: '2', type: 'merged', ts: at(30) }),
    event({ issue: '3', type: 'issue-title', ts: at(0) }),
  ];

  it('computes readinessScoredRuns, meanReadinessScore, and a ready/not-ready split', () => {
    const kpis = computeHealthKpis(readyEvents, []);

    expect(kpis.runs).toBe(3);
    expect(kpis.readinessScoredRuns).toBe(2);
    expect(kpis.meanReadinessScore).toBeCloseTo(0.7);
    expect(kpis.readinessSplit).toEqual({
      ready: { runs: 1, meanRetries: 1, medianCycleTimeMs: 10_000 },
      notReady: { runs: 1, meanRetries: 0, medianCycleTimeMs: 30_000 },
    });
  });

  it('includes the readiness lines in formatKpiLines', () => {
    const kpis = computeHealthKpis(readyEvents, []);
    const lines = formatKpiLines(kpis);

    expect(lines).toContain('Issue readiness: mean 70% (2/3 runs scored)');
    expect(lines).toContain(
      'Readiness vs outcomes: ready 1 run (1.0 retries/run, cycle p50 10s) · not-ready 1 run (0.0 retries/run, cycle p50 30s)',
    );
  });

  it('yields null meanReadinessScore and readinessSplit, and no readiness lines, when zero runs are scored', () => {
    const events: FactoryEvent[] = [event({ issue: '1', type: 'issue-title' }), event({ issue: '1', type: 'merged' })];
    const kpis = computeHealthKpis(events, []);

    expect(kpis.readinessScoredRuns).toBe(0);
    expect(kpis.meanReadinessScore).toBeNull();
    expect(kpis.readinessSplit).toBeNull();
    expect(formatKpiLines(kpis).some((line) => line.startsWith('Issue readiness'))).toBe(false);
  });

  it('round-trips meanReadinessScore through kpisToHistoryRecord', () => {
    const kpis = computeHealthKpis(readyEvents, []);
    const record = kpisToHistoryRecord(kpis, '2026-07-20');
    expect(record.meanReadinessScore).toBeCloseTo(0.7);
  });
});

describe('size gate KPIs (#608)', () => {
  const sizedEvents: FactoryEvent[] = [
    event({ issue: '1', type: 'issue-title' }),
    event({
      issue: '1',
      type: 'readiness',
      readiness: { template: 'factory-task', score: 1, pass: true, missing: [], sizeOk: true },
    }),
    event({ issue: '2', type: 'issue-title' }),
    event({
      issue: '2',
      type: 'readiness',
      readiness: {
        template: 'factory-task',
        score: 1,
        pass: true,
        missing: [],
        sizeOk: false,
        sizeReason: 'too big: 7 in-scope items, 8 acceptance criteria',
      },
    }),
    event({ issue: '3', type: 'issue-title' }),
  ];

  it('computes the four fields', () => {
    const kpis = computeHealthKpis(sizedEvents, []);

    expect(kpis.runs).toBe(3);
    expect(kpis.sizeScoredRuns).toBe(2);
    expect(kpis.sizeGateEscalatedRuns).toBe(1);
    expect(kpis.sizeGateEscalationRate).toBeCloseTo(1 / 3);
    expect(kpis.meanSizeScore).toBe(0.5);
  });

  it('excludes legacy readiness events with no size verdict', () => {
    const events: FactoryEvent[] = [
      event({ issue: '1', type: 'issue-title' }),
      event({
        issue: '1',
        type: 'readiness',
        readiness: { template: 'factory-task', score: 1, pass: true, missing: [] },
      }),
    ];
    const kpis = computeHealthKpis(events, []);

    expect(kpis.sizeScoredRuns).toBe(0);
    expect(kpis.meanSizeScore).toBeNull();
    expect(kpis.sizeGateEscalationRate).toBe(0);
    expect(kpis.readinessScoredRuns).toBe(1);
  });

  it('renders the size-gate line', () => {
    const kpis = computeHealthKpis(sizedEvents, []);
    const lines = formatKpiLines(kpis);

    expect(lines).toContain('Size gate: escalated 33% (1/3) · mean size score 50% (2/3 runs size-scored)');
  });

  it('omits the line when nothing is size-scored', () => {
    const kpis = computeHealthKpis([event({ issue: '1', type: 'issue-title' })], []);
    const lines = formatKpiLines(kpis);

    expect(lines.some((line) => line.startsWith('Size gate'))).toBe(false);
    expect(renderKpiReport(kpis)).not.toContain('Size gate');
  });

  it('all runs escalated', () => {
    const events: FactoryEvent[] = [
      event({ issue: '1', type: 'issue-title' }),
      event({
        issue: '1',
        type: 'readiness',
        readiness: { template: 'factory-task', score: 1, pass: true, missing: [], sizeOk: false },
      }),
      event({ issue: '2', type: 'issue-title' }),
      event({
        issue: '2',
        type: 'readiness',
        readiness: { template: 'factory-task', score: 1, pass: true, missing: [], sizeOk: false },
      }),
    ];
    const kpis = computeHealthKpis(events, []);

    expect(kpis.sizeGateEscalationRate).toBe(1);
    expect(kpis.meanSizeScore).toBe(0);
  });

  it('round-trips through kpi-history', () => {
    const kpis = computeHealthKpis(sizedEvents, []);
    const record = kpisToHistoryRecord(kpis, '2026-08-10');
    const jsonl = appendKpiHistoryLine('', record);
    const [parsed] = parseKpiHistory(jsonl);

    expect(parsed.sizeGateEscalationRate).toBeCloseTo(1 / 3);
    expect(parsed.meanSizeScore).toBe(0.5);
  });

  it('legacy history rows still parse', () => {
    const legacy: KpiHistoryRecord = {
      date: '2026-07-17',
      runs: 3,
      mergeRate: 1,
      reworkRate: 0,
      stuckRate: 0,
      humanInterventionRate: 0,
      fullyAutonomousRate: 0,
      costPerMergedPr: null,
      medianCycleTimeMs: null,
      p90CycleTimeMs: null,
    };

    const jsonl = appendKpiHistoryLine('', legacy);
    const [parsed] = parseKpiHistory(jsonl);

    expect(parsed.sizeGateEscalationRate).toBeUndefined();
    expect(parsed.meanSizeScore).toBeUndefined();
    expect(() => renderKpiTrend([parsed])).not.toThrow();
  });
});

describe('post-merge defect KPIs (#612)', () => {
  it('is null (not 0) when no run has a closed defect window', () => {
    const kpis = computeHealthKpis([event({ issue: '1', type: 'merged' })], []);

    expect(kpis.defectWindowClosedRuns).toBe(0);
    expect(kpis.postMergeDefectRuns).toBe(0);
    expect(kpis.postMergeDefectSignals).toBe(0);
    expect(kpis.postMergeDefectRate).toBeNull();
  });

  it('scores window-closed runs, ignoring a merged run whose window has not closed', () => {
    const events: FactoryEvent[] = [
      event({ issue: '1', type: 'merged' }),
      event({ issue: '1', type: 'defect-window-closed', msg: 'PR #1 post-merge defect window closed (14d)' }),
      event({ issue: '1', type: 'post-merge-defect', msg: 'revert commit abcdef1 reverts PR #1' }),
      event({ issue: '1', type: 'post-merge-defect', msg: 'comment on PR #1 raises a post-merge concern' }),
      event({ issue: '2', type: 'merged' }),
      event({ issue: '2', type: 'defect-window-closed', msg: 'PR #2 post-merge defect window closed (14d)' }),
      event({ issue: '3', type: 'merged' }),
    ];
    const kpis = computeHealthKpis(events, []);

    expect(kpis.defectWindowClosedRuns).toBe(2);
    expect(kpis.postMergeDefectRuns).toBe(1);
    expect(kpis.postMergeDefectSignals).toBe(2);
    expect(kpis.postMergeDefectRate).toBe(0.5);
  });

  it('ignores a post-merge-defect event on a run with no defect-window-closed event', () => {
    const kpis = computeHealthKpis(
      [event({ issue: '1', type: 'merged' }), event({ issue: '1', type: 'post-merge-defect', msg: 'stray signal' })],
      [],
    );

    expect(kpis.defectWindowClosedRuns).toBe(0);
    expect(kpis.postMergeDefectRuns).toBe(0);
    expect(kpis.postMergeDefectSignals).toBe(0);
    expect(kpis.postMergeDefectRate).toBeNull();
  });

  it('omits the report line when the cohort is empty, and renders it with correct pluralization when non-empty', () => {
    const emptyKpis = computeHealthKpis([event({ issue: '1', type: 'merged' })], []);
    expect(formatKpiLines(emptyKpis).some((line) => line.startsWith('Post-merge defects'))).toBe(false);

    const events: FactoryEvent[] = [
      event({ issue: '1', type: 'merged' }),
      event({ issue: '1', type: 'defect-window-closed', msg: 'a' }),
      event({ issue: '1', type: 'post-merge-defect', msg: 'b' }),
      event({ issue: '1', type: 'post-merge-defect', msg: 'c' }),
      event({ issue: '2', type: 'merged' }),
      event({ issue: '2', type: 'defect-window-closed', msg: 'd' }),
    ];
    const kpis = computeHealthKpis(events, []);
    expect(formatKpiLines(kpis)).toContain('Post-merge defects: 50% (1/2 runs with a closed defect window, 2 signals)');

    const singularKpis = computeHealthKpis(
      [
        event({ issue: '1', type: 'merged' }),
        event({ issue: '1', type: 'defect-window-closed', msg: 'a' }),
        event({ issue: '1', type: 'post-merge-defect', msg: 'b' }),
      ],
      [],
    );
    expect(formatKpiLines(singularKpis)).toContain(
      'Post-merge defects: 100% (1/1 runs with a closed defect window, 1 signal)',
    );
  });

  it('round-trips postMergeDefectRate and defectWindowClosedRuns through kpi-history, and legacy rows still parse', () => {
    const events: FactoryEvent[] = [
      event({ issue: '1', type: 'merged' }),
      event({ issue: '1', type: 'defect-window-closed', msg: 'a' }),
      event({ issue: '1', type: 'post-merge-defect', msg: 'b' }),
      event({ issue: '2', type: 'merged' }),
      event({ issue: '2', type: 'defect-window-closed', msg: 'c' }),
    ];
    const kpis = computeHealthKpis(events, []);
    const record = kpisToHistoryRecord(kpis, '2026-08-10');
    const jsonl = appendKpiHistoryLine('', record);
    const [parsed] = parseKpiHistory(jsonl);

    expect(parsed.postMergeDefectRate).toBe(0.5);
    expect(parsed.defectWindowClosedRuns).toBe(2);

    const legacy: KpiHistoryRecord = {
      date: '2026-07-17',
      runs: 3,
      mergeRate: 1,
      reworkRate: 0,
      stuckRate: 0,
      humanInterventionRate: 0,
      fullyAutonomousRate: 0,
      costPerMergedPr: null,
      medianCycleTimeMs: null,
      p90CycleTimeMs: null,
    };
    const legacyJsonl = appendKpiHistoryLine('', legacy);
    const [parsedLegacy] = parseKpiHistory(legacyJsonl);
    expect(parsedLegacy.postMergeDefectRate).toBeUndefined();
    expect(parsedLegacy.defectWindowClosedRuns).toBeUndefined();
  });
});

describe('collision-caused rework KPIs (#615)', () => {
  it('counts a run whose rework was caused by a merge conflict toward collisionReworkRuns/Rate', () => {
    const events: FactoryEvent[] = [
      event({ issue: '1', type: 'issue-title' }),
      event({ issue: '1', type: 'conflict', msg: 'rebase conflict on issue-1-branch — parked' }),
      event({ issue: '2', type: 'issue-title' }),
      event({ issue: '2', type: 'rework', rework: { round: 1, failingChecks: ['tests'], cause: 'factory-fault' } }),
      event({ issue: '3', type: 'issue-title' }),
      event({ issue: '3', type: 'merged' }),
      event({ issue: '4', type: 'issue-title' }),
    ];

    const kpis = computeHealthKpis(events, []);

    expect(kpis.reworkRuns).toBe(1);
    expect(kpis.reworkRate).toBe(0.25);
    expect(kpis.collisionReworkRuns).toBe(1);
    expect(kpis.collisionReworkRate).toBe(0.25);
  });

  it('does not count a checker-caused rework toward collisionReworkRuns', () => {
    const events: FactoryEvent[] = [
      event({ issue: '1', type: 'issue-title' }),
      event({ issue: '1', type: 'rework', rework: { round: 1, failingChecks: ['tests'], cause: 'factory-fault' } }),
    ];

    const kpis = computeHealthKpis(events, []);

    expect(kpis.reworkRuns).toBe(1);
    expect(kpis.collisionReworkRuns).toBe(0);
    expect(kpis.collisionReworkRate).toBe(0);
  });

  it('is 0, not an error, for an empty log', () => {
    const kpis = computeHealthKpis([], []);
    expect(kpis.collisionReworkRuns).toBe(0);
    expect(kpis.collisionReworkRate).toBe(0);
  });

  it('includes the collision-caused rework line in formatKpiLines', () => {
    const events: FactoryEvent[] = [
      event({ issue: '1', type: 'issue-title' }),
      event({ issue: '1', type: 'conflict', msg: 'rebase conflict — parked' }),
      event({ issue: '2', type: 'issue-title' }),
    ];
    const kpis = computeHealthKpis(events, []);
    expect(formatKpiLines(kpis)).toContain('Collision-caused rework rate: 50% (1/2)');
  });

  it('computes and writes collisionReworkRate to kpi-history alongside reworkRate, and legacy rows still parse', () => {
    const events: FactoryEvent[] = [
      event({ issue: '1', type: 'issue-title' }),
      event({ issue: '1', type: 'conflict', msg: 'rebase conflict — parked' }),
      event({ issue: '2', type: 'issue-title' }),
      event({ issue: '2', type: 'merged' }),
    ];
    const kpis = computeHealthKpis(events, []);
    const record = kpisToHistoryRecord(kpis, '2026-08-10');
    const jsonl = appendKpiHistoryLine('', record);
    const [parsed] = parseKpiHistory(jsonl);

    expect(parsed.reworkRate).toBe(0);
    expect(parsed.collisionReworkRate).toBe(0.5);

    const legacy: KpiHistoryRecord = {
      date: '2026-07-17',
      runs: 3,
      mergeRate: 1,
      reworkRate: 0,
      stuckRate: 0,
      humanInterventionRate: 0,
      fullyAutonomousRate: 0,
      costPerMergedPr: null,
      medianCycleTimeMs: null,
      p90CycleTimeMs: null,
    };
    const legacyJsonl = appendKpiHistoryLine('', legacy);
    const [parsedLegacy] = parseKpiHistory(legacyJsonl);
    expect(parsedLegacy.collisionReworkRate).toBeUndefined();
  });
});

describe('parallel throughput and concurrency KPIs (#657)', () => {
  it('reports achievedConcurrency of 2 while two lane windows overlap', () => {
    const events: FactoryEvent[] = [
      event({ issue: '1', type: 'issue-title', lane: 'a', ts: at(0) }),
      event({ issue: '1', type: 'merged', lane: 'a', ts: at(100) }),
      event({ issue: '2', type: 'issue-title', lane: 'b', ts: at(50) }),
      event({ issue: '2', type: 'merged', lane: 'b', ts: at(150) }),
    ];

    const kpis = computeHealthKpis(events, []);

    expect(kpis.configuredLanes).toBe(2);
    expect(kpis.achievedConcurrency.max).toBe(2);
    // [0,50) 1 lane, [50,100) 2 lanes, [100,150] 1 lane, over a 150s span.
    expect(kpis.achievedConcurrency.mean).toBeCloseTo(200 / 150, 5);
    expect(kpis.parallelEfficiency).toBeCloseTo(200 / 150 / 2, 5);
  });

  it('reports achievedConcurrency of 1 outside any overlap, for sequential lane windows', () => {
    const events: FactoryEvent[] = [
      event({ issue: '1', type: 'issue-title', lane: 'a', ts: at(0) }),
      event({ issue: '1', type: 'merged', lane: 'a', ts: at(100) }),
      event({ issue: '2', type: 'issue-title', lane: 'b', ts: at(100) }),
      event({ issue: '2', type: 'merged', lane: 'b', ts: at(200) }),
    ];

    const kpis = computeHealthKpis(events, []);

    expect(kpis.achievedConcurrency.max).toBe(1);
    expect(kpis.achievedConcurrency.mean).toBe(1);
    expect(kpis.parallelEfficiency).toBe(0.5);
  });

  it('is null/0 when no run carries a lane and a complete start/merge window', () => {
    const kpis = computeHealthKpis([event({ issue: '1', type: 'issue-title' })], []);

    expect(kpis.configuredLanes).toBe(0);
    expect(kpis.achievedConcurrency).toEqual({ mean: null, max: 0 });
    expect(kpis.parallelEfficiency).toBe(0);
  });

  it('computes prsPerHour from a known wall-clock span and merge count', () => {
    const events: FactoryEvent[] = [
      event({ issue: '1', type: 'issue-title', ts: at(0) }),
      event({ issue: '1', type: 'merged', ts: at(600) }),
      event({ issue: '2', type: 'issue-title', ts: at(0) }),
      event({ issue: '2', type: 'merged', ts: at(1200) }),
      event({ issue: '3', type: 'issue-title', ts: at(0) }),
      event({ issue: '3', type: 'merged', ts: at(7200) }),
    ];

    const kpis = computeHealthKpis(events, []);

    // 3 merged runs over a 2-hour span (0 -> 7200s).
    expect(kpis.prsPerHour).toBe(1.5);
  });

  it('is null when there are no merges', () => {
    const kpis = computeHealthKpis([event({ issue: '1', type: 'issue-title' })], []);
    expect(kpis.prsPerHour).toBeNull();
  });

  it('includes the throughput and concurrency line in formatKpiLines', () => {
    const events: FactoryEvent[] = [
      event({ issue: '1', type: 'issue-title', lane: 'a', ts: at(0) }),
      event({ issue: '1', type: 'merged', lane: 'a', ts: at(3600) }),
    ];
    const kpis = computeHealthKpis(events, []);
    const line = formatKpiLines(kpis).find((l) => l.startsWith('Throughput:'));

    expect(line).toBe(
      'Throughput: 1.00 PRs/hour · achieved concurrency: mean 1.00, max 1 (of 1 configured lane) · parallel efficiency 100%',
    );
  });

  it('persists prsPerHour, configuredLanes, achievedConcurrency, and parallelEfficiency to kpi-history', () => {
    const events: FactoryEvent[] = [
      event({ issue: '1', type: 'issue-title', lane: 'a', ts: at(0) }),
      event({ issue: '1', type: 'merged', lane: 'a', ts: at(3600) }),
    ];
    const kpis = computeHealthKpis(events, []);
    const record = kpisToHistoryRecord(kpis, '2026-08-10');
    const jsonl = appendKpiHistoryLine('', record);
    const [parsed] = parseKpiHistory(jsonl);

    expect(parsed.prsPerHour).toBe(1);
    expect(parsed.configuredLanes).toBe(1);
    expect(parsed.achievedConcurrencyMean).toBe(1);
    expect(parsed.achievedConcurrencyMax).toBe(1);
    expect(parsed.parallelEfficiency).toBe(1);

    const legacy: KpiHistoryRecord = {
      date: '2026-07-17',
      runs: 3,
      mergeRate: 1,
      reworkRate: 0,
      stuckRate: 0,
      humanInterventionRate: 0,
      fullyAutonomousRate: 0,
      costPerMergedPr: null,
      medianCycleTimeMs: null,
      p90CycleTimeMs: null,
    };
    const legacyJsonl = appendKpiHistoryLine('', legacy);
    const [parsedLegacy] = parseKpiHistory(legacyJsonl);
    expect(parsedLegacy.prsPerHour).toBeUndefined();
    expect(parsedLegacy.achievedConcurrencyMean).toBeUndefined();
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
      fullyAutonomousRate: 0.25,
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
    expect(trend).toContain(
      '| date | runs | merge | rework | stuck | human | auto | $/merged | cycle p50 | cycle p90 |',
    );
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
    expect(row).toBe('| 2026-07-17 | 3 | 100% | 0% | 0% | 0% | — | — | — | — |');
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
      collisionReworkRate: 0,
      stuckRate: 0,
      humanInterventionRate: 0,
      fullyAutonomousRate: 1,
      costPerMergedPr: null,
      medianCycleTimeMs: 0,
      p90CycleTimeMs: 0,
      meanReadinessScore: null,
      sizeGateEscalationRate: 0,
      meanSizeScore: null,
      postMergeDefectRate: null,
      defectWindowClosedRuns: 0,
      phaseDurationsMs: {},
      phaseCosts: {},
      retriesByCause: { checker: 0, failover: 0, timeout: 0, other: 0 },
      prsPerHour: null,
      configuredLanes: 0,
      achievedConcurrencyMean: null,
      achievedConcurrencyMax: 0,
      parallelEfficiency: 0,
      medianCostPerMergedPr: null,
      costScoredMergedRuns: 0,
      costRows: 0,
      costCoverage: null,
      estimatedCostShare: null,
      costByRoute: {},
    });
  });

  it('includes commitSha/models when meta is provided, omits both when it is not', () => {
    const kpis = computeHealthKpis(
      [event({ issue: '1', type: 'issue-title' }), event({ issue: '1', type: 'merged' })],
      [],
    );

    const withMeta = kpisToHistoryRecord(kpis, '2026-07-20', {
      commitSha: 'abc123',
      models: { boss: ['m1'], worker: ['m2', 'm3'] },
    });
    expect(withMeta.commitSha).toBe('abc123');
    expect(withMeta.models).toEqual({ boss: ['m1'], worker: ['m2', 'm3'] });

    const withoutMeta = kpisToHistoryRecord(kpis, '2026-07-20');
    expect('commitSha' in withoutMeta).toBe(false);
    expect('models' in withoutMeta).toBe(false);
  });

  it('round-trips commitSha and models through append/parse', () => {
    const record = historyRecord({ commitSha: 'deadbeef', models: { boss: ['claude'], worker: ['codex', 'ollama'] } });
    const jsonl = appendKpiHistoryLine('', record);
    const [parsed] = parseKpiHistory(jsonl);
    expect(parsed.commitSha).toBe('deadbeef');
    expect(parsed.models).toEqual({ boss: ['claude'], worker: ['codex', 'ollama'] });
  });

  it('omits the delta line with a single record', () => {
    const trend = renderKpiTrend([historyRecord()]);
    expect(trend).not.toContain('Δ vs previous');
  });

  it('renders a delta line comparing the last two records', () => {
    const records = [
      historyRecord({ date: '2026-07-18', runs: 4, mergeRate: 0.5, reworkRate: 0.3, stuckRate: 0.1 }),
      historyRecord({ date: '2026-07-19', runs: 9, mergeRate: 0.6, reworkRate: 0.3, stuckRate: 0.05 }),
    ];

    const trend = renderKpiTrend(records);
    const deltaLine = trend.split('\n').find((line) => line.startsWith('Δ vs previous'));
    expect(deltaLine).toBeDefined();
    expect(deltaLine).toContain('runs +5');
    expect(deltaLine).toContain('merge +10pp');
    expect(deltaLine).toContain('rework 0pp');
    expect(deltaLine).toContain('stuck −5pp');
  });

  it('uses the last two records for the delta regardless of window size', () => {
    const records = [
      historyRecord({ date: '2026-07-10', runs: 1, mergeRate: 0 }),
      historyRecord({ date: '2026-07-18', runs: 4, mergeRate: 0.5 }),
      historyRecord({ date: '2026-07-19', runs: 9, mergeRate: 0.6 }),
    ];

    const trend = renderKpiTrend(records, { window: 1 });
    const deltaLine = trend.split('\n').find((line) => line.startsWith('Δ vs previous'));
    expect(deltaLine).toContain('runs +5');
    expect(deltaLine).toContain('merge +10pp');
  });

  it('renders — for null/missing metrics in the delta line', () => {
    const legacyPrev = {
      date: '2026-07-17',
      runs: 3,
      mergeRate: 1,
      reworkRate: 0,
      stuckRate: 0,
      humanInterventionRate: 0,
      costPerMergedPr: null,
    } as KpiHistoryRecord;
    const curr = historyRecord({ date: '2026-07-18', costPerMergedPr: 1.5 });

    const trend = renderKpiTrend([legacyPrev, curr]);
    const deltaLine = trend.split('\n').find((line) => line.startsWith('Δ vs previous'));
    expect(deltaLine).toContain('$/merged —');
    expect(deltaLine).toContain('auto —');
    expect(deltaLine).toContain('cycle p50 —');
    expect(deltaLine).toContain('cycle p90 —');
  });
});

describe('KPI drift detection (#613)', () => {
  function driftRecord(date: string, overrides: Partial<KpiHistoryRecord> = {}): KpiHistoryRecord {
    return {
      date,
      runs: 5,
      mergeRate: 1,
      reworkRate: 0.1,
      stuckRate: 0,
      humanInterventionRate: 0,
      fullyAutonomousRate: 1,
      costPerMergedPr: 1,
      medianCycleTimeMs: 100_000,
      p90CycleTimeMs: 150_000,
      ...overrides,
    };
  }

  function window(count: number, overrides: Partial<KpiHistoryRecord> = {}): KpiHistoryRecord[] {
    return Array.from({ length: count }, (_, i) => driftRecord(`2026-07-${String(i + 1).padStart(2, '0')}`, overrides));
  }

  it('exposes the window size and threshold as named, tunable constants', () => {
    expect(KPI_DRIFT_WINDOW_SIZE).toBe(20);
    expect(KPI_DRIFT_THRESHOLD_RATIO).toBe(0.25);
  });

  it('fires drift when the second half is visibly worse on rework rate, cost, and cycle time', () => {
    const baseline = window(20, { reworkRate: 0.1, costPerMergedPr: 1, medianCycleTimeMs: 100_000 });
    const recent = window(20, { reworkRate: 0.2, costPerMergedPr: 1.5, medianCycleTimeMs: 200_000 });
    const records = [...baseline, ...recent];

    const report = computeKpiDrift(records);
    expect(report.ready).toBe(true);
    expect(report.drift).toBe(true);
    expect(report.reworkRate.drift).toBe(true);
    expect(report.costPerMergedPr.drift).toBe(true);
    expect(report.medianCycleTimeMs.drift).toBe(true);
    expect(report.reworkRate.deltaRatio).toBeCloseTo(1);
    expect(report.reworkRate.baseline).toBeCloseTo(0.1);
    expect(report.reworkRate.recent).toBeCloseTo(0.2);

    const line = renderKpiDriftLine(report);
    expect(line).toContain('⚠ Drift detected');
    expect(line).toContain('rework rate +100%');

    const trend = renderKpiTrend(records);
    expect(trend).toContain('⚠ Drift detected');
  });

  it('does not fire drift on a flat or improving series', () => {
    const flat = window(20, { reworkRate: 0.1, costPerMergedPr: 1, medianCycleTimeMs: 100_000 });
    const improving = window(20, { reworkRate: 0.05, costPerMergedPr: 0.8, medianCycleTimeMs: 80_000 });
    const records = [...flat, ...improving];

    const report = computeKpiDrift(records);
    expect(report.ready).toBe(true);
    expect(report.drift).toBe(false);
    expect(report.reworkRate.drift).toBe(false);
    expect(report.costPerMergedPr.drift).toBe(false);
    expect(report.medianCycleTimeMs.drift).toBe(false);

    const trend = renderKpiTrend(records);
    expect(trend).toContain('No drift');
  });

  it('does not evaluate drift with fewer than two full windows of history', () => {
    const records = window(10);

    const report = computeKpiDrift(records);
    expect(report.ready).toBe(false);
    expect(report.drift).toBe(false);

    const trend = renderKpiTrend(records);
    expect(trend).not.toContain('Drift');
  });

  it('never triggers on a metric where both windows are entirely null', () => {
    const records = window(40, { costPerMergedPr: null });

    const report = computeKpiDrift(records);
    expect(report.ready).toBe(true);
    expect(report.drift).toBe(false);
    expect(report.costPerMergedPr).toEqual({ baseline: null, recent: null, deltaRatio: null, drift: false });
    expect(renderKpiDriftLine(report)).toContain('cost/merged PR n/a');
  });

  it('treats a baseline mean of zero with a non-zero recent mean as drift', () => {
    const baseline = window(20, { reworkRate: 0 });
    const recent = window(20, { reworkRate: 0.1 });
    const records = [...baseline, ...recent];

    const report = computeKpiDrift(records);
    expect(report.reworkRate.baseline).toBe(0);
    expect(report.reworkRate.recent).toBeCloseTo(0.1);
    expect(report.reworkRate.deltaRatio).toBeNull();
    expect(report.reworkRate.drift).toBe(true);
    expect(report.drift).toBe(true);
    expect(renderKpiDriftLine(report)).toContain('rework rate n/a (baseline 0% → recent 10%) ⚠');
  });

  it('supports a configurable window size and threshold', () => {
    const baseline = window(5, { reworkRate: 0.1 });
    const recent = window(5, { reworkRate: 0.2 });
    const records = [...baseline, ...recent];

    const lenient = computeKpiDrift(records, { windowSize: 5, thresholdRatio: 2 });
    expect(lenient.ready).toBe(true);
    expect(lenient.reworkRate.deltaRatio).toBeCloseTo(1);
    expect(lenient.reworkRate.drift).toBe(false);

    const strict = computeKpiDrift(records, { windowSize: 5, thresholdRatio: 0.1 });
    expect(strict.reworkRate.drift).toBe(true);
  });
});
