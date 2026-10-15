// packages/cli/src/cli/ship-reap.test.ts — `factory ship` removes a clean PR-less worktree and branch (#3008)
import { describe, expect, it } from 'vitest';

import { h, installShipHarness, logged, ops, runMainWith, trackEnv } from './test-support/ship-harness.js';

installShipHarness();

describe('ship (via cmdShip) PR-less worktree reap', () => {
  it('removes a clean PR-less worktree and branch after PLAN escalates (#3008)', async () => {
    h.planResult = { ok: false, route: 'claude', escalate: 'needs human' };
    const res = await runMainWith(undefined, 'ship', '5');
    expect(res).toEqual({ exited: true, code: 1 });
    expect(ops.reapCleanShipWorktree).toHaveBeenCalledTimes(1);
    expect(ops.reapCleanShipWorktree).toHaveBeenCalledWith(
      h.repoRoot,
      expect.stringContaining('5'),
      expect.objectContaining({ issue: 5 }),
    );
    expect(logged()).toContain('Removed worktree');
    expect(logged()).toContain('factory/5-fix-the-bug');
  });

  it('removes a clean PR-less worktree and branch after a failed ship (#3008)', async () => {
    trackEnv('FACTORY_LOCAL_ONLY');
    process.env.FACTORY_LOCAL_ONLY = '1';
    h.checkResult = {
      passed: false,
      summary: { results: [{ checker: 'lint', result: 'FAIL', details: 'bad' }], failures: 1 },
      reworkRounds: 2,
    };
    const res = await runMainWith(undefined, 'ship', '5');
    expect(res).toEqual({ exited: true, code: 1 });
    expect(ops.reapCleanShipWorktree).toHaveBeenCalledTimes(1);
    expect(logged()).toContain('Removed worktree');
  });

  it('does not reap the worktree when the ship opens a PR (#3008)', async () => {
    const res = await runMainWith(undefined, 'ship', '5');
    expect(res.exited).toBe(false);
    expect(ops.reapCleanShipWorktree).not.toHaveBeenCalled();
  });

  it('prints no removal line when the worktree is kept (#3008)', async () => {
    h.shipReap = { outcome: 'kept-committed', branch: 'factory/5-fix-the-bug', branchDeleted: false };
    h.planResult = { ok: false, route: 'claude', escalate: 'needs human' };
    const res = await runMainWith(undefined, 'ship', '5');
    expect(res).toEqual({ exited: true, code: 1 });
    expect(logged()).not.toContain('Removed worktree');
  });

  it('never changes the ship exit when the reap throws (#3008)', async () => {
    ops.reapCleanShipWorktree.mockRejectedValueOnce(new Error('boom'));
    h.planResult = { ok: false, route: 'claude', escalate: 'needs human' };
    const res = await runMainWith(undefined, 'ship', '5');
    expect(res).toEqual({ exited: true, code: 1 });
    expect(logged()).not.toContain('Removed worktree');
  });
});
