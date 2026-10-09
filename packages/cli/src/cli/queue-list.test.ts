import { describe, expect, it } from 'vitest';
import type { QueueSnapshot } from '@on-par/factory-core/internal';
import { buildQueueListJson } from './queue-list.js';

const snapshot: QueueSnapshot = {
  entries: [
    { issue: 7, lane: 'access', title: 'Seven' },
    { issue: 11, lane: 'cleanup', title: 'Eleven' },
    { issue: 12, lane: 'cleanup', title: 'Twelve' },
  ],
} as QueueSnapshot;

describe('buildQueueListJson', () => {
  it('groups by lane in reader order with 1-based order', () => {
    expect(buildQueueListJson(snapshot)).toEqual({
      schemaVersion: 1,
      lanes: [
        { lane: 'access', items: [{ issue: 7, title: 'Seven', status: 'queued', order: 1, claimedBy: null }] },
        {
          lane: 'cleanup',
          items: [
            { issue: 11, title: 'Eleven', status: 'queued', order: 1, claimedBy: null },
            { issue: 12, title: 'Twelve', status: 'queued', order: 2, claimedBy: null },
          ],
        },
      ],
    });
  });

  it('filters by lane; unknown lane gives no lanes', () => {
    expect(buildQueueListJson(snapshot, 'cleanup').lanes.map((l) => l.lane)).toEqual(['cleanup']);
    expect(buildQueueListJson(snapshot, 'nope').lanes).toEqual([]);
  });

  it('reports parked status and claimant', () => {
    const out = buildQueueListJson({
      entries: [
        { issue: 1, lane: 'a', status: 'parked' },
        { issue: 2, lane: 'a', status: 'in-progress', claimant: 'host-1' },
      ],
    } as QueueSnapshot);
    expect(out.lanes[0]?.items[0]?.status).toBe('parked');
    expect(out.lanes[0]?.items[1]).toMatchObject({ status: 'in-progress', claimedBy: 'host-1', order: 2 });
  });

  it('handles an empty snapshot', () => {
    expect(buildQueueListJson({ entries: [] })).toEqual({ schemaVersion: 1, lanes: [] });
  });

  it('omits title when absent and defaults status to queued', () => {
    const item = buildQueueListJson({ entries: [{ issue: 3, lane: 'a' }] } as QueueSnapshot).lanes[0]?.items[0];
    expect(item).toBeDefined();
    expect('title' in item!).toBe(false);
    expect(item?.status).toBe('queued');
  });
});
