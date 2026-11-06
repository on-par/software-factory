import { describe, expect, it, vi } from 'vitest';

import { retentionBudgetPass, retentionReclaimer, underSweepLocks } from './worktree-retention.js';

const config: any = { worktree: { retainMax: 4 }, sandbox: undefined, run: {} };
const report = { retained: 0, target: 0, evict: [], protected: [], evicted: [], failed: [] };

function where(over: Record<string, unknown> = {}): any {
  return {
    repoRoot: '/tmp/retention-cli-repo',
    ghRepo: 'o/r',
    paths: { mergeLock: '/tmp/retention-cli-merge.lock', gitLock: '/tmp/retention-cli-git.lock' },
    protectedIssues: () => new Set([5]),
    log: vi.fn(),
    ...over,
  };
}

describe('retentionReclaimer', () => {
  it('passes pressure, the policy and the in-flight set through to the reclaim', async () => {
    const reclaim = vi.fn(async () => report);
    const w = where();
    await expect(retentionReclaimer(config, w, { reclaim })(true)).resolves.toBe(report);
    const [opts] = reclaim.mock.calls[0] as any[];
    expect(opts).toMatchObject({ pressure: true, policy: { maxRetained: 4 }, repo: 'o/r' });
    expect([...opts.protectedIssues]).toEqual([5]);
    await retentionReclaimer(config, w, { reclaim })(false);
    expect((reclaim.mock.calls[1] as any[])[0].pressure).toBe(false);
  });

  it("returns 'skipped' and warns when the reclaim throws", async () => {
    const w = where();
    const reclaim = vi.fn(async () => {
      throw new Error('git broke');
    });
    await expect(retentionReclaimer(config, w, { reclaim })(true)).resolves.toBe('skipped');
    expect(w.log).toHaveBeenCalledWith('warn', expect.stringContaining('git broke'));
  });

  it("returns 'skipped' quietly when the merge lock is held", async () => {
    const w = where();
    const reclaim = vi.fn(async () => {
      throw Object.assign(new Error('lock timeout'), { reason: 'timeout' });
    });
    await expect(retentionReclaimer(config, w, { reclaim })(true)).resolves.toBe('skipped');
    expect(w.log).not.toHaveBeenCalled();
  });
});

describe('retentionBudgetPass', () => {
  const cfg: any = { worktree: { retainMax: 2 } };
  const opts = { repoRoot: '/r', protectedIssues: new Set([1]) };

  it('summarizes an eviction and resolves the policy from the config', async () => {
    const reclaim = vi.fn(async () => ({ ...report, retained: 3, evicted: [{} as never] }));
    const msg = await retentionBudgetPass(reclaim, cfg, opts, {});
    expect(msg).toBe('retention: evicted 1 of 3 retained worktree(s) (budget 2)');
    expect((reclaim.mock.calls[0] as any[])[0]).toMatchObject({ policy: { maxRetained: 2 }, repoRoot: '/r' });
  });

  it('is silent when nothing was evicted and warns instead of throwing', async () => {
    await expect(retentionBudgetPass(async () => report, cfg, opts, {})).resolves.toBeNull();
    const log = vi.fn();
    const boom = async () => {
      throw new Error('nope');
    };
    await expect(retentionBudgetPass(boom, cfg, opts, { log })).resolves.toBeNull();
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('nope'));
  });
});

describe('underSweepLocks', () => {
  it('runs the body under the git, merge and git-file locks', async () => {
    await expect(underSweepLocks('/tmp/retention-cli-repo', where().paths, async () => 'done')).resolves.toBe('done');
  });
});
