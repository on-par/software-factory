import { describe, expect, it } from 'vitest';

import {
  aggregateShipPhaseBreakdown,
  renderShipPhaseBreakdown,
  type ShipPhaseBreakdownEvent,
} from './ship-phase-breakdown.js';

const EVENTS: ShipPhaseBreakdownEvent[] = [
  { ts: '2026-09-08T00:00:00.000Z', type: 'phase_started', msg: 'plan started', phase: 'plan' },
  { ts: '2026-09-08T00:00:01.000Z', type: 'adr_inject_started', msg: 'reading ADRs', phase: 'plan' },
  {
    ts: '2026-09-08T00:00:01.500Z',
    type: 'adr_inject_completed',
    msg: 'ADR injection complete (0 active)',
    phase: 'plan',
    durationMs: 500,
  },
  { ts: '2026-09-08T00:00:05.000Z', type: 'phase_completed', msg: 'plan done', phase: 'plan', durationMs: 5000 },
  { ts: '2026-09-08T00:00:05.100Z', type: 'phase_started', msg: 'build started', phase: 'build' },
  { ts: '2026-09-08T00:00:15.100Z', type: 'phase_completed', msg: 'build done', phase: 'build', durationMs: 10000 },
  { ts: '2026-09-08T00:00:15.200Z', type: 'phase_started', msg: 'check started', phase: 'check' },
  {
    ts: '2026-09-08T00:00:17.200Z',
    type: 'checker_started',
    msg: 'checker compile started',
    phase: 'check',
  },
  {
    ts: '2026-09-08T00:00:18.200Z',
    type: 'checker_completed',
    msg: 'checker compile completed (PASS)',
    phase: 'check',
    durationMs: 1000,
  },
  {
    ts: '2026-09-08T00:00:18.300Z',
    type: 'checker_started',
    msg: 'checker tests started',
    phase: 'check',
  },
  {
    ts: '2026-09-08T00:00:20.300Z',
    type: 'checker_completed',
    msg: 'checker tests completed (PASS)',
    phase: 'check',
    durationMs: 2000,
  },
  { ts: '2026-09-08T00:00:20.400Z', type: 'phase_completed', msg: 'check done', phase: 'check', durationMs: 5200 },
  { ts: '2026-09-08T00:00:20.500Z', type: 'phase_started', msg: 'ship started', phase: 'ship' },
  { ts: '2026-09-08T00:00:22.500Z', type: 'phase_completed', msg: 'ship done', phase: 'ship', durationMs: 2000 },
];

describe('aggregateShipPhaseBreakdown', () => {
  it('sums phase_completed durations per phase, descending by duration', () => {
    const breakdown = aggregateShipPhaseBreakdown(EVENTS);
    expect(breakdown.totalDurationMs).toBe(5000 + 10000 + 5200 + 2000);
    expect(breakdown.phases).toEqual([
      { name: 'build', durationMs: 10000, count: 1 },
      { name: 'check', durationMs: 5200, count: 1 },
      { name: 'plan', durationMs: 5000, count: 1 },
      { name: 'ship', durationMs: 2000, count: 1 },
    ]);
  });

  it('parses checker names out of checker_completed messages, descending by duration', () => {
    const breakdown = aggregateShipPhaseBreakdown(EVENTS);
    expect(breakdown.checkers).toEqual([
      { name: 'tests', durationMs: 2000, count: 1 },
      { name: 'compile', durationMs: 1000, count: 1 },
    ]);
  });

  it('sums adr_inject_completed durations separately as a subset of PLAN', () => {
    const breakdown = aggregateShipPhaseBreakdown(EVENTS);
    expect(breakdown.adrInjectionMs).toBe(500);
  });

  it('accumulates repeated phase/checker names instead of overwriting', () => {
    const breakdown = aggregateShipPhaseBreakdown([
      ...EVENTS,
      { ts: '2026-09-08T00:00:23.000Z', type: 'phase_started', msg: 'check re-started', phase: 'check' },
      {
        ts: '2026-09-08T00:00:24.000Z',
        type: 'checker_completed',
        msg: 'checker compile completed (PASS)',
        phase: 'check',
        durationMs: 500,
      },
      { ts: '2026-09-08T00:00:25.000Z', type: 'phase_completed', msg: 'check done', phase: 'check', durationMs: 1000 },
    ]);
    expect(breakdown.phases.find((row) => row.name === 'check')).toEqual({ name: 'check', durationMs: 6200, count: 2 });
    expect(breakdown.checkers.find((row) => row.name === 'compile')).toEqual({
      name: 'compile',
      durationMs: 1500,
      count: 2,
    });
  });

  it('ignores events with no durationMs and events with an unrecognized type', () => {
    const breakdown = aggregateShipPhaseBreakdown([
      { ts: '2026-09-08T00:00:00.000Z', type: 'phase_completed', msg: 'plan done', phase: 'plan' },
      { ts: '2026-09-08T00:00:01.000Z', type: 'router', msg: 'trying model', durationMs: 999 },
    ]);
    expect(breakdown.totalDurationMs).toBe(0);
    expect(breakdown.phases).toEqual([]);
    expect(breakdown.checkers).toEqual([]);
    expect(breakdown.adrInjectionMs).toBe(0);
  });

  it('returns an all-zero breakdown for an empty event list', () => {
    expect(aggregateShipPhaseBreakdown([])).toEqual({
      totalDurationMs: 0,
      phases: [],
      checkers: [],
      adrInjectionMs: 0,
    });
  });
});

describe('renderShipPhaseBreakdown', () => {
  it('renders a markdown report with phase and checker tables', () => {
    const markdown = renderShipPhaseBreakdown(EVENTS);
    expect(markdown).toContain('# Ship-phase duration breakdown');
    expect(markdown).toContain('Total measured phase duration: 22200ms');
    expect(markdown).toContain('ADR injection (subset of PLAN): 500ms');
    expect(markdown).toContain('| build | 10000 | 45.0% | 1 |');
    expect(markdown).toContain('| tests | 2000 | 1 |');
    expect(markdown).toContain('| compile | 1000 | 1 |');
  });

  it('renders an explicit placeholder row when a table has no data', () => {
    const markdown = renderShipPhaseBreakdown([]);
    expect(markdown).toContain('Total measured phase duration: 0ms');
    expect(markdown).toContain('_none recorded_');
  });
});
