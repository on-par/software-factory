// packages/cli/src/cli/worktree-reap.test.ts — formatShipReapLine run-output lines (#3009)
import { join } from 'node:path';

import { getFactoryPaths } from '@on-par/factory-core';
import type { reapCleanShipWorktree } from '@on-par/factory-core/internal';
import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { formatShipReapLine, reapPrlessShip, type ReapRuntime } from './worktree-reap.js';

const WT = '/wt/5';
const BR = 'factory/5-fix';

describe('formatShipReapLine', () => {
  it('reports the removal with the deleted branch', () => {
    const line = formatShipReapLine(WT, { outcome: 'removed', branch: BR, branchDeleted: true });
    expect(line).toBe(`🧹 Removed worktree ${WT} and branch ${BR} — no PR was opened and nothing was committed`);
  });

  it('omits the branch when it was not deleted', () => {
    const line = formatShipReapLine(WT, { outcome: 'removed', branch: BR, branchDeleted: false });
    expect(line).toBe(`🧹 Removed worktree ${WT} — no PR was opened and nothing was committed`);
  });

  it('explains a dirty keep', () => {
    const line = formatShipReapLine(WT, { outcome: 'kept-dirty', branch: BR, branchDeleted: false });
    expect(line).toContain(WT);
    expect(line).toContain(BR);
    expect(line).toContain('uncommitted changes');
  });

  it('explains a keep-record keep', () => {
    const line = formatShipReapLine(WT, { outcome: 'kept-record', branch: BR, branchDeleted: false });
    expect(line).toContain(WT);
    expect(line).toContain(BR);
    expect(line).toContain('keep record');
  });

  it('explains a committed keep', () => {
    const line = formatShipReapLine(WT, { outcome: 'kept-committed', branch: BR, branchDeleted: false });
    expect(line).toContain(WT);
    expect(line).toContain('commits beyond the base');
  });

  it('names the non-lane branch', () => {
    const line = formatShipReapLine(WT, { outcome: 'kept-branch-mismatch', branch: 'main', branchDeleted: false });
    expect(line).toContain(WT);
    expect(line).toContain("'main'");
  });

  it('reports unverified state for kept-unverified and for a thrown reap', () => {
    const unverified = formatShipReapLine(WT, { outcome: 'kept-unverified', branch: null, branchDeleted: false });
    expect(unverified).toContain(WT);
    expect(unverified).toContain('could not be verified');
    expect(formatShipReapLine(WT, undefined)).toBe(unverified);
  });

  it('prints nothing for an absent worktree', () => {
    expect(formatShipReapLine(WT, { outcome: 'absent', branch: null, branchDeleted: false })).toBeNull();
  });
});

describe('reapPrlessShip', () => {
  const tmp = createTempDirs();
  afterEach(async () => {
    await tmp.cleanup();
    vi.restoreAllMocks();
  });

  function setup(rt: Partial<ReapRuntime['configLoaders']>, worktreePathFor: ReapRuntime['worktreePathFor']) {
    const dir = tmp.makeSync('reap-prless-');
    const repoRoot = join(dir, 'repo');
    const paths = getFactoryPaths(repoRoot, join(dir, 'state'));
    const runtime: ReapRuntime = {
      configLoaders: { loadFactoryConfigForRepo: () => ({}) as never, loadRepoConfig: () => ({}) as never, ...rt },
      worktreePathFor,
    };
    const reap = vi.fn<typeof reapCleanShipWorktree>(async () => {
      throw new Error('reap failed');
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const args: [number, string, string, typeof paths, undefined] = [999998, repoRoot, 'o/r', paths, undefined];
    return { runtime, reap, log, args };
  }

  it('prints no kept-worktree line when the config could not be loaded', async () => {
    const { runtime, reap, log, args } = setup(
      {
        loadFactoryConfigForRepo: () => {
          throw new Error('expected object, received null');
        },
      },
      () => '/never',
    );
    await reapPrlessShip(runtime, reap, args);
    expect(reap).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().join('\n')).not.toMatch(/Kept (the )?worktree/);
  });

  it('still reports an unverified worktree when the path resolved and the reap threw', async () => {
    const { runtime, reap, log, args } = setup({}, () => '/wt/999998');
    await reapPrlessShip(runtime, reap, args);
    expect(log.mock.calls.flat().join('\n')).toContain('Kept worktree /wt/999998 — its state could not be verified');
  });
});
