// packages/cli/src/cli/repo-live-run-lock.test.ts — fail-closed live-run check for an attached repo (#3643)
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { repoHasLiveRunLock } from './repo-live-run-lock.js';

describe('repoHasLiveRunLock', () => {
  it('is false for a repo with no run locks', () => {
    const dir = mkdtempSync(join(tmpdir(), 'live-run-lock-'));
    try {
      expect(repoHasLiveRunLock({ path: dir })).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed when the lock listing throws', () => {
    expect(repoHasLiveRunLock({ path: '\0' })).toBe(true);
  });
});
