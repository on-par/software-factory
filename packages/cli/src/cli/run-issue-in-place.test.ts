// packages/cli/src/cli/run-issue-in-place.test.ts — `factory run-issue --in-place` (#3904)
import { afterEach, describe, expect, it } from 'vitest';

import type { CliDeps } from './index.js';
import { errored, h, installShipHarness, phases, runMainWith } from './test-support/ship-harness.js';

installShipHarness();

type InPlaceProblem = Awaited<ReturnType<NonNullable<CliDeps['checkInPlaceCheckout']>>>;

function recorders(dirty: InPlaceProblem = null) {
  const worktrees: Array<[string, string, string, string | undefined]> = [];
  const inPlace: Array<[string, string]> = [];
  const checks: string[] = [];
  const plans: number[] = [];
  const builds: string[] = [];
  const checksRun: string[] = [];
  h.setupWorktreeImpl = async (repoRoot, branch, worktree, start) => {
    worktrees.push([repoRoot, branch, worktree, start]);
  };
  const deps: CliDeps = {
    checkInPlaceCheckout: async (repoRoot) => {
      checks.push(repoRoot);
      return dirty;
    },
    setupInPlaceCheckout: async (repoRoot, branch) => {
      inPlace.push([repoRoot, branch]);
      return { base: 'origin/main', head: 'abc', remoteBranch: null };
    },
    planPhase: async (opts) => {
      plans.push(1);
      return phases.planPhase(opts);
    },
    buildPhase: async (opts) => {
      builds.push(opts.worktree);
      return h.buildResult;
    },
    checkPhase: async (opts) => {
      checksRun.push(opts.worktree);
      return phases.checkPhase(opts);
    },
  };
  return { worktrees, inPlace, checks, plans, builds, checksRun, deps };
}

afterEach(() => {
  delete process.env.FACTORY_WORKSPACE;
});

describe('run-issue --in-place (#3904)', () => {
  it('--in-place runs in the repo root without setupWorktree', async () => {
    const r = recorders();
    const res = await runMainWith(r.deps, 'run-issue', '5', '--in-place', '--no-pr');

    expect(res.exited).toBe(false);
    expect(r.worktrees).toEqual([]);
    expect(r.inPlace.map(([root]) => root)).toEqual([h.repoRoot]);
  });

  it('--in-place passes the repo root as the BUILD and CHECK worktree', async () => {
    const r = recorders();
    await runMainWith(r.deps, 'run-issue', '5', '--in-place', '--no-pr');

    expect(r.builds).toEqual([h.repoRoot]);
    expect(r.checksRun).toEqual([h.repoRoot]);
  });

  it('--in-place on a dirty checkout exits 2 before PLAN and names the files', async () => {
    const r = recorders({
      kind: 'dirty',
      files: ['a.ts', 'b.ts'],
      message: 'in-place run refused: the checkout has uncommitted changes: a.ts, b.ts — commit',
    });

    const res = await runMainWith(r.deps, 'run-issue', '5', '--in-place');

    expect(res).toEqual({ exited: true, code: 2 });
    expect(r.plans).toEqual([]);
    expect(r.inPlace).toEqual([]);
    expect(errored()).toContain('a.ts, b.ts');
  });

  it('FACTORY_WORKSPACE=in-place runs in place like --in-place', async () => {
    process.env.FACTORY_WORKSPACE = 'in-place';
    const r = recorders();
    const res = await runMainWith(r.deps, 'run-issue', '5', '--no-pr');

    expect(res.exited).toBe(false);
    expect(r.worktrees).toEqual([]);
    expect(r.inPlace).toHaveLength(1);
  });

  it('--in-place uses the same branch name as worktree mode', async () => {
    const r1 = recorders();
    await runMainWith(r1.deps, 'run-issue', '5', '--no-pr');
    const worktreeBranch = r1.worktrees[0]?.[1];
    const r2 = recorders();
    await runMainWith(r2.deps, 'run-issue', '5', '--in-place', '--no-pr');

    expect(worktreeBranch).toMatch(/5/);
    expect(r2.inPlace[0]?.[1]).toBe(worktreeBranch);
  });

  it('--in-place with --base-branch exits 2', async () => {
    const r = recorders();
    const res = await runMainWith(r.deps, 'run-issue', '5', '--in-place', '--base-branch', 'dev');

    expect(res).toEqual({ exited: true, code: 2 });
    expect(errored()).toContain('--in-place runs on the default branch');
    expect(r.inPlace).toEqual([]);
  });

  it('--in-place with --stack exits 2', async () => {
    const res = await runMainWith(recorders().deps, 'run-issue', '5', '--in-place', '--stack');

    expect(res).toEqual({ exited: true, code: 2 });
    expect(errored()).toContain('--in-place builds one branch');
  });

  it('without --in-place run-issue calls setupWorktree with the lane worktree path', async () => {
    const r = recorders();
    await runMainWith(r.deps, 'run-issue', '5', '--no-pr');

    expect(r.inPlace).toEqual([]);
    expect(r.checks).toEqual([]);
    const worktree = r.worktrees[0]?.[2];
    expect(worktree).toBeTruthy();
    expect(worktree).not.toBe(h.repoRoot);
  });

  it('FACTORY_WORKSPACE=worktree keeps worktree mode', async () => {
    process.env.FACTORY_WORKSPACE = 'worktree';
    const r = recorders();
    await runMainWith(r.deps, 'run-issue', '5', '--no-pr');

    expect(r.worktrees).toHaveLength(1);
    expect(r.inPlace).toEqual([]);
  });
});
