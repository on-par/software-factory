import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readPortLeases } from '../environment/index.js';
import { ProcessGroupTracker, type KillOutcome } from '../environment/process-groups.js';
import { createSimWorkspace } from '../testing/sim/workspace.js';
import type { WorktreeSandbox } from '../utils/microvm.js';
import type { LocalOnlyPolicy } from '../work/local-only.js';
import {
  acquireLaneEnvironment,
  type Environment,
  inPlaceWorkspace,
  localOnlyWorkspace,
  simWorkspace,
  type Workspace,
  worktreeWorkspace,
} from './ports.js';

const LOCK_OPTS = { pollMs: 5 };

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'run-ports-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

class RecordingTracker extends ProcessGroupTracker {
  killed: number[][] = [];
  override async killAll(): Promise<KillOutcome[]> {
    this.killed.push(this.pgids);
    return [];
  }
}

function recorder(result?: unknown) {
  const calls: unknown[][] = [];
  const fn = async (...args: unknown[]) => {
    calls.push(args);
    return result as never;
  };
  return { fn, calls };
}

describe('localOnlyWorkspace', () => {
  it('wraps a LocalOnlyPolicy as a Workspace using the policy workspace path as-is', async () => {
    const policy: LocalOnlyPolicy = { mode: 'local-only', workspace: '/tmp/some-repo' };
    const ws: Workspace = localOnlyWorkspace(policy);
    expect(ws.path).toBe(policy.workspace);
    await expect(ws.dispose()).resolves.toBeUndefined();
  });
});

describe('inPlaceWorkspace', () => {
  it('inPlaceWorkspace path is the repo root and forwards the remote branch', async () => {
    const { fn: setup, calls: setupCalls } = recorder({ base: 'origin/main', head: 'x', remoteBranch: { sha: 'abc' } });
    const findOpenPr = async () => ({ status: 'absent' as const });
    const ws = await inPlaceWorkspace({ repoRoot: '/repo', branch: 'b', findOpenPr, setup });
    expect(ws.path).toBe('/repo');
    expect(ws.remoteBranch).toEqual({ sha: 'abc' });
    expect(setupCalls).toEqual([['/repo', 'b', undefined, { findOpenPr }]]);
  });

  it('inPlaceWorkspace dispose leaves the checkout in place', async () => {
    await withTmpDir(async (dir) => {
      const { fn: setup } = recorder({ base: 'origin/main', head: 'x', remoteBranch: null });
      const ws = await inPlaceWorkspace({ repoRoot: dir, branch: 'b', setup });
      expect(ws.remoteBranch).toBeUndefined();
      await ws.dispose();
      expect(existsSync(dir)).toBe(true);
    });
  });
});

describe('simWorkspace', () => {
  it('wraps a SimWorkspace as a Workspace, delegating dispose to the sim, which tolerates a second dispose', async () => {
    const sim = await createSimWorkspace();
    const ws: Workspace = simWorkspace(sim);
    expect(ws.path).toBe(sim.repoRoot);
    await ws.dispose();
    await expect(sim.dispose()).resolves.toBeUndefined();
  });
});

describe('worktreeWorkspace', () => {
  it('copies the pre-existing remote branch from the setup result and forwards findOpenPr (#1868)', async () => {
    const { fn: setup, calls: setupCalls } = recorder({ base: 'origin/main', head: 'x', remoteBranch: { sha: 'abc' } });
    const findOpenPr = async () => ({ status: 'absent' as const });

    const ws = await worktreeWorkspace({
      repoRoot: '/repo',
      branch: 'issue-9',
      worktreePath: '/repo/.worktrees/issue-9',
      findOpenPr,
      keepsFile: '/state/worktree-keeps.json',
      setup,
      cleanup: async () => {},
    });

    expect(ws.remoteBranch).toEqual({ sha: 'abc' });
    expect(setupCalls[0]?.[6]).toEqual({ findOpenPr, keepsFile: '/state/worktree-keeps.json' });
  });

  it('leaves remoteBranch absent when the setup result has none', async () => {
    const { fn: setup } = recorder({ base: 'origin/main', head: 'x', remoteBranch: null });

    const ws = await worktreeWorkspace({
      repoRoot: '/repo',
      branch: 'issue-10',
      worktreePath: '/repo/.worktrees/issue-10',
      setup,
      cleanup: async () => {},
    });

    expect('remoteBranch' in ws).toBe(false);
  });

  const sandbox: WorktreeSandbox = { runtime: 'docker-sandbox', authPaths: ['/home/.claude'], allowHosts: [] };
  it.each([
    ['without a sandbox', undefined],
    ['with the sandbox descriptor forwarded to both setup and cleanup', sandbox],
  ])('provisions via injected setup and tears down via injected cleanup %s', async (_name, sbx) => {
    const { fn: setup, calls: setupCalls } = recorder();
    const { fn: cleanup, calls: cleanupCalls } = recorder();
    const log = () => {};
    const path = '/repo/.worktrees/issue-1';

    const ws: Workspace = await worktreeWorkspace({
      repoRoot: '/repo',
      branch: 'issue-1',
      worktreePath: path,
      sandbox: sbx,
      setup,
      cleanup,
      log,
    });

    expect(setupCalls).toEqual([['/repo', 'issue-1', path, undefined, sbx, log, { findOpenPr: undefined }]]);
    expect(ws.path).toBe(path);

    await ws.dispose();
    expect(cleanupCalls).toEqual([['/repo', path, log, sbx]]);
  });

  it('passes an explicit startPoint through to setup verbatim', async () => {
    const { fn: setup, calls: setupCalls } = recorder();
    await worktreeWorkspace({
      repoRoot: '/repo',
      branch: 'issue-2',
      worktreePath: '/repo/.worktrees/issue-2',
      startPoint: 'origin/develop',
      setup,
      cleanup: async () => {},
    });

    expect(setupCalls[0]?.slice(0, 4)).toEqual(['/repo', 'issue-2', '/repo/.worktrees/issue-2', 'origin/develop']);
  });
});

describe('acquireLaneEnvironment', () => {
  it('bundles port lease + env + pgid tracking + release into one Environment', async () => {
    await withTmpDir(async (dir) => {
      const registryFile = join(dir, 'ports.json');
      const lockDir = join(dir, 'ports.lock');
      const tracker = new RecordingTracker();

      const env: Environment = await acquireLaneEnvironment({
        registryFile,
        lockDir,
        worktreeId: '/wt/lane-a',
        branch: 'lane-a',
        range: [3100, 3199],
        isPortFree: async () => true,
        lockOpts: LOCK_OPTS,
        tracker,
      });

      expect(env.port).toBeGreaterThanOrEqual(3100);
      expect(env.port).toBeLessThanOrEqual(3199);

      const vars = env.env();
      expect(vars.PORT).toBe(String(env.port));
      expect(vars.FACTORY_APP_PORT).toBe(String(env.port));
      expect(vars.FACTORY_BASE_URL).toBe(`http://127.0.0.1:${env.port}`);

      env.recordPgid(1234);
      expect(tracker.pgids).toContain(1234);
      await new Promise((r) => setTimeout(r, 20));
      const leaseAfterRecord = readPortLeases(registryFile).find((l) => l.worktreeId === '/wt/lane-a');
      expect(leaseAfterRecord?.pgids).toContain(1234);

      await env.release();
      expect(tracker.killed).toEqual([[1234]]);
      expect(readPortLeases(registryFile).some((l) => l.worktreeId === '/wt/lane-a')).toBe(false);
    });
  });

  it('honors an explicit baseUrl override in env()', async () => {
    await withTmpDir(async (dir) => {
      const registryFile = join(dir, 'ports.json');
      const lockDir = join(dir, 'ports.lock');

      const env = await acquireLaneEnvironment({
        registryFile,
        lockDir,
        worktreeId: '/wt/lane-b',
        branch: 'lane-b',
        range: [3200, 3299],
        isPortFree: async () => true,
        lockOpts: LOCK_OPTS,
        baseUrl: 'https://lane-b.example.test',
      });

      expect(env.env().FACTORY_BASE_URL).toBe('https://lane-b.example.test');
      await env.release();
    });
  });
});
