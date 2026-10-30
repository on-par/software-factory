// packages/cli/src/cli/repo-live-run-lock.test.ts — fail-closed live-run check for an attached repo (#3643)
import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { repoHasLiveRunLock } from './repo-live-run-lock.js';

const tmp = createTempDirs();
afterEach(() => tmp.cleanup());

describe('repoHasLiveRunLock', () => {
  it('is false for a repo with no run locks', () => {
    const dir = tmp.makeSync('live-run-lock-');
    expect(repoHasLiveRunLock({ path: dir })).toBe(false);
  });

  it('fails closed when the lock listing throws', () => {
    expect(repoHasLiveRunLock({ path: '\0' })).toBe(true);
  });
});
