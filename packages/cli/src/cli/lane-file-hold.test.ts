import { join } from 'node:path';

import { LaneFileGuard, workKeyFromIssue } from '@on-par/factory-core';
import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { laneFileHoldLookup } from './lane-file-hold.js';

describe('laneFileHoldLookup', () => {
  const temps = createTempDirs();
  let dir: string;
  beforeEach(async () => {
    dir = await temps.make('lane-file-hold-');
  });
  afterEach(async () => {
    await temps.cleanup();
  });

  it('returns the live hold with a numeric holder, and undefined without one', async () => {
    const file = join(dir, 'lane-files.json');
    const guard = new LaneFileGuard(file);
    const lookup = laneFileHoldLookup(file, 'o/r');
    await expect(lookup(8)).resolves.toBeUndefined();

    await guard.register('o/r', workKeyFromIssue(7), ['a.ts']);
    await guard.recordHold('o/r', workKeyFromIssue(8), { issue: workKeyFromIssue(7), file: 'a.ts' });
    await expect(lookup(8)).resolves.toEqual({ holder: 7, file: 'a.ts' });
  });
});
