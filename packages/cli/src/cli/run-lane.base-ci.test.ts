import { join } from 'node:path';
import { getFactoryPaths } from '@on-par/factory-core';
import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, expect, it } from 'vitest';
import { BaseCiPendingError } from './merge-base-gate.js';
import { runLane } from './run-lane.js';

const dirs = createTempDirs();
afterEach(() => dirs.cleanup());

it('releases the issue to the queue when base CI blocks landing', async () => {
  const dir = dirs.makeSync('lane-base-ci-');
  const paths = { ...getFactoryPaths(dir), events: join(dir, 'events.ndjson'), stop: join(dir, 'STOP') };
  const released: Array<[number, string]> = [];
  const releaseIssue = async (...a: [number, string]) => void released.push(a);
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
  expect(released).toEqual([[5, 'queued']]);
  expect(events).not.toContain('parked');
});
