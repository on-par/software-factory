import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LaneFileGuard, workKeyFromIssue } from '@on-par/factory-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { laneFileHoldLookup } from './lane-file-hold.js';

describe('laneFileHoldLookup', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lane-file-hold-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
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
