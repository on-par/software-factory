import { describe, expect, it, vi } from 'vitest';

import type { LaneState } from '../dashboard.js';
import { readLaneHeartbeats } from './lane-heartbeats.js';

const lane = (issue: string, status: LaneState['status']): LaneState => ({ issue, status }) as LaneState;

describe('readLaneHeartbeats', () => {
  it('reads the snapshot file of each non-terminal lane and maps unreadable ones to undefined', async () => {
    const readSnapshot = vi.fn(async (file: string) => {
      if (file.endsWith('issue-2.phase.json')) throw new Error('boom');
      return { lastActivityAt: `at:${file}` } as never;
    });
    const out = await readLaneHeartbeats(
      [lane('1', 'running'), lane('2', 'running'), lane('3', 'merged')],
      '/runs',
      readSnapshot,
    );
    expect(out).toEqual({ '1': 'at:/runs/issue-1.phase.json', '2': undefined });
    expect(readSnapshot).toHaveBeenCalledTimes(2);
  });
});
