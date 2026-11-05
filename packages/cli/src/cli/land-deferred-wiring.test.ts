// packages/cli/src/cli/land-deferred-wiring.test.ts — production wiring of the land-deferred record and retry (#3957)

import { getFactoryPaths, type FactoryConfig } from '@on-par/factory-core';
import { landDeferredFile, readLandDeferred } from '@on-par/factory-core/internal';
import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { landDeferredLaneDeps } from './land-deferred-wiring.js';
import { LandDeferredError } from './land-pr.js';

const dirs = createTempDirs();
afterEach(() => dirs.cleanup());

function wiring(max: number) {
  const dir = dirs.makeSync('land-deferred-wiring-');
  const paths = getFactoryPaths(dir);
  const config = { merge: { maxLandDeferrals: max } } as FactoryConfig;
  return { paths, deps: landDeferredLaneDeps('o/r', dir, paths, config) };
}
const err = new LandDeferredError('base kept moving', 7, 'factory/5-x');

describe('landDeferredLaneDeps (#3957)', () => {
  it('records a deferral until the cap, then returns park and clears the record', async () => {
    const { paths, deps } = wiring(2);
    const file = landDeferredFile(paths);
    const first = await deps.recordLandDeferred?.(err, 5, 'factory/5-x');
    expect(first).toMatchObject({ kind: 'defer', maxDeferrals: 2, record: { deferrals: 1 } });
    expect(await readLandDeferred(file)).toHaveLength(1);
    expect(await deps.recordLandDeferred?.(err, 5, 'factory/5-x')).toMatchObject({ kind: 'defer' });
    const third = await deps.recordLandDeferred?.(err, 5, 'factory/5-x');
    expect(third).toMatchObject({ kind: 'park', maxDeferrals: 2 });
    expect(await readLandDeferred(file)).toEqual([]);
  });

  it('a retry with nothing due takes the slot once and calls nothing', async () => {
    const { deps } = wiring(3);
    const emit = vi.fn();
    await deps.retryLandDeferred?.({ park: vi.fn(), emit });
    expect(emit).not.toHaveBeenCalled();
  });
});
