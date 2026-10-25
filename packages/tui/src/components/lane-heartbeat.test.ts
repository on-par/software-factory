import type { RunPhaseSnapshot } from '@on-par/factory-core';
import { describe, expect, it, vi } from 'vitest';

import { readLaneHeartbeat } from './lane-heartbeat.js';

const snapshot = { issue: 12, phase: 'build', updatedAt: 'u', lastActivityAt: 'a' } as RunPhaseSnapshot;

describe('readLaneHeartbeat', () => {
  it('reads the issue-<n>.phase.json file and returns lastActivityAt', async () => {
    const read = vi.fn(async () => snapshot);
    expect(await readLaneHeartbeat('/tmp/runs', '12', read)).toBe('a');
    expect(read).toHaveBeenCalledWith('/tmp/runs/issue-12.phase.json');
  });

  it('is undefined for a missing snapshot, a read failure, or a non-numeric lane issue', async () => {
    expect(await readLaneHeartbeat('/tmp/runs', '12', async () => null)).toBeUndefined();
    expect(
      await readLaneHeartbeat('/tmp/runs', '12', async () => {
        throw new Error('boom');
      }),
    ).toBeUndefined();
    const read = vi.fn(async () => snapshot);
    expect(await readLaneHeartbeat('/tmp/runs', 'PROJ-1', read)).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
  });
});
