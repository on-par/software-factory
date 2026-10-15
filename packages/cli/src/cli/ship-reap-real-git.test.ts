// packages/cli/src/cli/ship-reap-real-git.test.ts — `factory ship` really removes / keeps a PR-less worktree on a real git fixture (#3010)
import { execFile as execFileCb } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { reapCleanShipWorktree, setupWorktree as realSetupWorktree } from '@on-par/factory-core/internal';
import { createSimWorkspace, type SimWorkspace } from '@on-par/factory-core/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { h, installShipHarness, logged, paths, runMainWith, setupWorktree } from './test-support/ship-harness.js';

const execFile = promisify(execFileCb);

installShipHarness();

let ws: SimWorkspace | undefined;

// Registered after installShipHarness(), so it runs first and can still read the spy calls.
afterEach(async () => {
  for (const call of setupWorktree.mock.calls) rmSync(call[2], { recursive: true, force: true });
  await ws?.dispose();
  ws = undefined;
});

/** Points the harness at a real throwaway git repo with the real setupWorktree; PLAN then escalates. */
async function useRealGitRepo(): Promise<void> {
  ws = await createSimWorkspace();
  rmSync(h.repoRoot, { recursive: true, force: true });
  h.repoRoot = ws.repoRoot;
  mkdirSync(paths().state, { recursive: true });
  mkdirSync(paths().plans, { recursive: true });
  h.factoryConfig = { ...h.factoryConfig, sandbox: { ...h.factoryConfig.sandbox, enabled: false } };
  h.setupWorktreeImpl = async (repoRoot, branch, worktree, startPoint) => {
    await realSetupWorktree(repoRoot, branch, worktree, startPoint);
  };
  h.planResult = { ok: false, route: 'claude', escalate: 'needs human' };
}

async function branchExists(repoRoot: string, branch: string): Promise<boolean> {
  const { stdout } = await execFile('git', ['branch', '--list', branch], { cwd: repoRoot });
  return stdout.trim() !== '';
}

describe('ship (via cmdShip) PR-less worktree reap on a real git repo', () => {
  it('removes the real worktree and branch when PLAN escalates on a clean zero-commit lane (#3010)', async () => {
    await useRealGitRepo();
    const res = await runMainWith({ reapCleanShipWorktree }, 'ship', '5');
    expect(res).toEqual({ exited: true, code: 1 });
    expect(setupWorktree).toHaveBeenCalledTimes(1);
    const [, branch, worktree] = setupWorktree.mock.calls[0];
    expect(branch).toMatch(/\/5-/);
    expect(existsSync(worktree)).toBe(false);
    expect(await branchExists(h.repoRoot, branch)).toBe(false);
    expect(logged()).toContain('Removed worktree');
    expect(logged()).toContain(worktree);
    expect(logged()).toContain(branch);
  }, 30_000);

  it('keeps the real worktree and prints the uncommitted-changes reason when PLAN escalates on a dirty lane (#3010)', async () => {
    await useRealGitRepo();
    h.setupWorktreeImpl = async (repoRoot, branch, worktree, startPoint) => {
      await realSetupWorktree(repoRoot, branch, worktree, startPoint);
      writeFileSync(join(worktree, 'WIP.txt'), 'uncommitted\n');
    };
    const res = await runMainWith({ reapCleanShipWorktree }, 'ship', '5');
    expect(res).toEqual({ exited: true, code: 1 });
    expect(setupWorktree).toHaveBeenCalledTimes(1);
    const [, branch, worktree] = setupWorktree.mock.calls[0];
    expect(existsSync(worktree)).toBe(true);
    expect(await branchExists(h.repoRoot, branch)).toBe(true);
    expect(logged()).toContain('Kept worktree');
    expect(logged()).toContain(worktree);
    expect(logged()).toContain('uncommitted changes');
    expect(logged()).not.toContain('Removed worktree');
  }, 30_000);
});
