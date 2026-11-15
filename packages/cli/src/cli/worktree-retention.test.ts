import { describe, expect, it } from 'vitest';

import { retentionBudgetPass, retentionReclaimer, underSweepLocks } from './worktree-retention.js';

const config: any = { worktree: { retainMax: 4 }, sandbox: undefined, run: {} };
const report = { retained: 0, target: 0, evict: [], protected: [], evicted: [], failed: [] };

function where(over: Record<string, unknown> = {}): any {
  const logs: Array<[string, string]> = [];
  return {
    logs,
    repoRoot: '/tmp/retention-cli-repo',
    ghRepo: 'o/r',
    paths: { mergeLock: '/tmp/retention-cli-merge.lock', gitLock: '/tmp/retention-cli-git.lock' },
    protectedIssues: () => new Set([5]),
    log: (k: string, m: string) => {
      logs.push([k, m]);
    },
    ...over,
  };
}

describe('retentionReclaimer', () => {
  it('passes pressure, the policy and the in-flight set through to the reclaim', async () => {
    const reclaimed: any[] = [];
    const reclaim = async (opts: any) => {
      reclaimed.push(opts);
      return report;
    };
    const w = where();
    await expect(retentionReclaimer(config, w, { reclaim })(true)).resolves.toBe(report);
    expect(reclaimed[0]).toMatchObject({ pressure: true, policy: { maxRetained: 4 }, repo: 'o/r' });
    expect([...reclaimed[0].protectedIssues]).toEqual([5]);
    await retentionReclaimer(config, w, { reclaim })(false);
    expect(reclaimed[1].pressure).toBe(false);
  });

  it("returns 'skipped' and warns when the reclaim throws", async () => {
    const w = where();
    const reclaim = async () => {
      throw new Error('git broke');
    };
    await expect(retentionReclaimer(config, w, { reclaim })(true)).resolves.toBe('skipped');
    expect(w.logs).toContainEqual(['warn', expect.stringContaining('git broke')]);
  });

  it("returns 'skipped' quietly when the merge lock is held", async () => {
    const w = where();
    const reclaim = async () => {
      throw Object.assign(new Error('lock timeout'), { reason: 'timeout' });
    };
    await expect(retentionReclaimer(config, w, { reclaim })(true)).resolves.toBe('skipped');
    expect(w.logs).toEqual([]);
  });
});

describe('retentionBudgetPass', () => {
  const cfg: any = { worktree: { retainMax: 2 } };
  const opts = { repoRoot: '/r', protectedIssues: new Set([1]) };

  it('summarizes an eviction and resolves the policy from the config', async () => {
    const reclaimed: any[] = [];
    const reclaim = async (o: any) => {
      reclaimed.push(o);
      return { ...report, retained: 3, evicted: [{} as never] };
    };
    const msg = await retentionBudgetPass(reclaim, cfg, opts, {});
    expect(msg).toBe('retention: evicted 1 of 3 retained worktree(s) (budget 2)');
    expect(reclaimed[0]).toMatchObject({ policy: { maxRetained: 2 }, repoRoot: '/r' });
  });

  it('is silent when nothing was evicted and warns instead of throwing', async () => {
    await expect(retentionBudgetPass(async () => report, cfg, opts, {})).resolves.toBeNull();
    const logs: Array<[string, string]> = [];
    const log = (k: string, m: string) => {
      logs.push([k, m]);
    };
    const boom = async () => {
      throw new Error('nope');
    };
    await expect(retentionBudgetPass(boom, cfg, opts, { log })).resolves.toBeNull();
    expect(logs).toContainEqual(['warn', expect.stringContaining('nope')]);
  });
});

describe('underSweepLocks', () => {
  it('runs the body under the git, merge and git-file locks', async () => {
    await expect(underSweepLocks('/tmp/retention-cli-repo', where().paths, async () => 'done')).resolves.toBe('done');
  });
});
