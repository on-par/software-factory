import type { QueueSnapshot } from '@on-par/factory-core';
import { describe, expect, it } from 'vitest';

import { initialDashboard, reduceDashboard } from './dashboard.js';
import { laneQueueRows } from './lane-queue.js';

const running = [
  { ts: '2026-01-01T00:00:00.000Z', type: 'plan' as const, issue: '10', msg: 'x', lane: 'prefix' },
].reduce(reduceDashboard, initialDashboard()).lanes;

describe('laneQueueRows', () => {
  it('numbers one lane queued entries in order and excludes other lanes', () => {
    const snap: QueueSnapshot = {
      entries: [
        { lane: 'prefix', issue: 1, title: 'a', status: 'queued' },
        { lane: 'docs', issue: 2 },
        { lane: 'prefix', issue: 3 },
      ],
    };
    expect(laneQueueRows('prefix', snap, [])).toEqual({
      rows: [
        { kind: 'queued', issue: '1', title: 'a', position: 1 },
        { kind: 'queued', issue: '3', position: 2 },
      ],
    });
  });

  it('drops issues the event log already has', () => {
    const snap: QueueSnapshot = {
      entries: [
        { lane: 'prefix', issue: 10 },
        { lane: 'prefix', issue: 11 },
      ],
    };
    expect(laneQueueRows('prefix', snap, running).rows).toEqual([{ kind: 'queued', issue: '11', position: 1 }]);
  });

  it('lists parked without a position and skips in-progress', () => {
    const snap: QueueSnapshot = {
      entries: [
        { lane: 'prefix', issue: 1, status: 'parked' },
        { lane: 'prefix', issue: 2, status: 'in-progress' },
      ],
    };
    expect(laneQueueRows('prefix', snap, []).rows).toEqual([{ kind: 'parked', issue: '1' }]);
  });

  it('reports unavailable and hides stale entries on error', () => {
    const snap: QueueSnapshot = { entries: [{ lane: 'prefix', issue: 1 }], error: 'boom' };
    expect(laneQueueRows('prefix', snap, [])).toEqual({ rows: [], unavailable: 'boom' });
  });
});
