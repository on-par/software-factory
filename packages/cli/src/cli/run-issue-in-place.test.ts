// packages/cli/src/cli/run-issue-in-place.test.ts — `factory run-issue --in-place` (#3904)
import { afterEach, describe, expect, it } from 'vitest';

import {
  checkInPlaceCheckout,
  errored,
  h,
  installShipHarness,
  phases,
  runMainWith,
  setupInPlaceCheckout,
  setupWorktree,
} from './test-support/ship-harness.js';

installShipHarness();

const runMain = (...args: string[]) => runMainWith(undefined, ...args);

afterEach(() => {
  delete process.env.FACTORY_WORKSPACE;
});

describe('run-issue --in-place (#3904)', () => {
  it('--in-place runs in the repo root without setupWorktree', async () => {
    const res = await runMain('run-issue', '5', '--in-place', '--no-pr');

    expect(res.exited).toBe(false);
    expect(setupWorktree).not.toHaveBeenCalled();
    expect(setupInPlaceCheckout).toHaveBeenCalledTimes(1);
    expect(setupInPlaceCheckout.mock.calls[0]?.[0]).toBe(h.repoRoot);
  });

  it('--in-place passes the repo root as the BUILD and CHECK worktree', async () => {
    await runMain('run-issue', '5', '--in-place', '--no-pr');

    expect(phases.buildPhase.mock.calls[0]?.[0]).toMatchObject({ worktree: h.repoRoot });
    expect(phases.checkPhase.mock.calls[0]?.[0]).toMatchObject({ worktree: h.repoRoot });
  });

  it('--in-place on a dirty checkout exits 2 before PLAN and names the files', async () => {
    checkInPlaceCheckout.mockResolvedValue({
      kind: 'dirty',
      files: ['a.ts', 'b.ts'],
      message: 'in-place run refused: the checkout has uncommitted changes: a.ts, b.ts — commit',
    });

    const res = await runMain('run-issue', '5', '--in-place');

    expect(res).toEqual({ exited: true, code: 2 });
    expect(phases.planPhase).not.toHaveBeenCalled();
    expect(setupInPlaceCheckout).not.toHaveBeenCalled();
    expect(errored()).toContain('a.ts, b.ts');
  });

  it('FACTORY_WORKSPACE=in-place runs in place like --in-place', async () => {
    process.env.FACTORY_WORKSPACE = 'in-place';
    const res = await runMain('run-issue', '5', '--no-pr');

    expect(res.exited).toBe(false);
    expect(setupWorktree).not.toHaveBeenCalled();
    expect(setupInPlaceCheckout).toHaveBeenCalledTimes(1);
  });

  it('--in-place uses the same branch name as worktree mode', async () => {
    await runMain('run-issue', '5', '--no-pr');
    const worktreeBranch = setupWorktree.mock.calls[0]?.[1];
    await runMain('run-issue', '5', '--in-place', '--no-pr');

    expect(worktreeBranch).toMatch(/5/);
    expect(setupInPlaceCheckout.mock.calls[0]?.[1]).toBe(worktreeBranch);
  });

  it('--in-place with --base-branch exits 2', async () => {
    const res = await runMain('run-issue', '5', '--in-place', '--base-branch', 'dev');

    expect(res).toEqual({ exited: true, code: 2 });
    expect(errored()).toContain('--in-place runs on the default branch');
    expect(setupInPlaceCheckout).not.toHaveBeenCalled();
  });

  it('--in-place with --stack exits 2', async () => {
    const res = await runMain('run-issue', '5', '--in-place', '--stack');

    expect(res).toEqual({ exited: true, code: 2 });
    expect(errored()).toContain('--in-place builds one branch');
  });

  it('without --in-place run-issue calls setupWorktree with the lane worktree path', async () => {
    await runMain('run-issue', '5', '--no-pr');

    expect(setupInPlaceCheckout).not.toHaveBeenCalled();
    expect(checkInPlaceCheckout).not.toHaveBeenCalled();
    const worktree = setupWorktree.mock.calls[0]?.[2];
    expect(worktree).toBeTruthy();
    expect(worktree).not.toBe(h.repoRoot);
  });

  it('FACTORY_WORKSPACE=worktree keeps worktree mode', async () => {
    process.env.FACTORY_WORKSPACE = 'worktree';
    await runMain('run-issue', '5', '--no-pr');

    expect(setupWorktree).toHaveBeenCalledTimes(1);
    expect(setupInPlaceCheckout).not.toHaveBeenCalled();
  });
});
