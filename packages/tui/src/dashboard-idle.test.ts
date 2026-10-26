import type { EventKind, FactoryEvent } from '@on-par/factory-core';
import { describe, expect, it } from 'vitest';

import {
  computeIdleReason,
  formatAgo,
  hasActiveLane,
  idleLine,
  initialDashboard,
  reduceDashboard,
} from './dashboard.js';

function ev(type: EventKind, issue: string, msg: string): FactoryEvent {
  return { ts: '2026-01-01T00:00:00.000Z', type, issue, msg };
}

function reduceAll(events: FactoryEvent[]) {
  return events.reduce(reduceDashboard, initialDashboard());
}

describe('idle reason helpers (#1365)', () => {
  const lane = (events: FactoryEvent[]) => reduceAll(events).lanes;

  it('hasActiveLane: only running, ready or waiting-merge lanes count', () => {
    expect(hasActiveLane([])).toBe(false);
    expect(hasActiveLane(lane([ev('plan', '1', 'x'), ev('parked', '1', 'x')]))).toBe(false);
    expect(hasActiveLane(lane([ev('plan', '1', 'x'), ev('plan', '2', 'x'), ev('parked', '1', 'x')]))).toBe(true);
    expect(hasActiveLane(lane([ev('plan', '1', 'x'), ev('await-merge', '1', 'x')]))).toBe(true);
  });

  it('computeIdleReason: unknown queue and active lanes give no reason', () => {
    const parked = lane([ev('plan', '1', 'x'), ev('parked', '1', 'x')]);
    const running = lane([ev('plan', '1', 'x')]);
    expect(computeIdleReason(running, { entries: [] })).toBeUndefined();
    expect(computeIdleReason([], undefined)).toBeUndefined();
    expect(computeIdleReason([], { entries: [], error: 'boom' })).toBeUndefined();
    expect(computeIdleReason([], { entries: [] })).toBe('queue-empty');
    expect(computeIdleReason(parked, { entries: [{ lane: 'a', issue: 2 }] })).toBe('all-parked-finished');
  });

  it('idleLine formats each reason, the source override and the bare form', () => {
    expect(idleLine('queue-empty')).toBe('no active work — GitHub queue empty');
    expect(idleLine('queue-empty', 'local file')).toBe('no active work — local file queue empty');
    expect(idleLine('all-parked-finished')).toBe('no active work — all runs parked/finished');
    expect(idleLine(undefined)).toBe('no active work');
  });

  it('formatAgo renders coarse ages and clamps or rejects bad input', () => {
    const now = Date.parse('2026-01-02T00:00:00.000Z');
    const ago = (sec: number) => new Date(now - sec * 1000).toISOString();
    expect(formatAgo(undefined, now)).toBe('unknown');
    expect(formatAgo('garbage', now)).toBe('unknown');
    expect(formatAgo(ago(-30), now)).toBe('0s ago');
    expect(formatAgo(ago(45), now)).toBe('45s ago');
    expect(formatAgo(ago(125), now)).toBe('2m ago');
    expect(formatAgo(ago(3 * 3600 + 5), now)).toBe('3h ago');
    expect(formatAgo(ago(2 * 86400 + 5), now)).toBe('2d ago');
  });
});
