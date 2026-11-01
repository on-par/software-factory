import { join } from 'node:path';
import { getFactoryPaths } from '@on-par/factory-core';
import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { BaseCiPendingError } from './merge-base-gate.js';
import { runLane } from './run-lane.js';

const dirs = createTempDirs();
afterEach(() => dirs.cleanup());

it('releases the issue to the queue when base CI blocks landing', async () => {
  const dir = dirs.makeSync('lane-base-ci-');
  const paths = { ...getFactoryPaths(dir), events: join(dir, 'events.ndjson'), stop: join(dir, 'STOP') };
  const releaseIssue = vi.fn(async () => {});
  const events: string[] = [];
  await runLane('app', [5], '/repo', 'o/r', paths, {
    ship: async () => 'factory/5-x',
    waitMerge: async () => {
      throw new BaseCiPendingError('base failed');
    },
    pathExists: () => false,
    emitEvent: (_file, kind) => {
      events.push(kind);
    },
    releaseIssue,
    reapWorktree: async () => {},
  });
  expect(releaseIssue).toHaveBeenCalledWith(5, 'queued');
  expect(events).not.toContain('parked');
});
