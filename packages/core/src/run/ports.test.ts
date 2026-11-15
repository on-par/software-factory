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
  readonly killed: number[][] = [];

  override async killAll(): Promise<KillOutcome[]> {
    this.killed.push(this.pgids);
    return [];
  }
}

function recordingSetup(result: unknown) {
  const setupCalls: unknown[][] = [];
  const setup = async (...args: unknown[]) => {
    setupCalls.push(args);
    return result as never;
  };
  return { setup, setupCalls };
}

function recordingCleanup() {
  const cleanupCalls: unknown[][] = [];
  const cleanup = async (...args: unknown[]) => {
    cleanupCalls.push(args);
  };
  return { cleanup, cleanupCalls };
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
    const { setup, setupCalls } = recordingSetup({ base: 'origin/main', head: 'x', remoteBranch: { sha: 'abc' } });
    const findOpenPr = async () => ({ status: 'absent' as const });
    const ws = await inPlaceWorkspace({ repoRoot: '/repo', branch: 'b', findOpenPr, setup });
    expect(ws.path).toBe('/repo');
    expect(ws.remoteBranch).toEqual({ sha: 'abc' });
    expect(setupCalls).toEqual([['/repo', 'b', undefined, { findOpenPr }]]);
  });

  it('inPlaceWorkspace dispose leaves the checkout in place', async () => {
    await withTmpDir(async (dir) => {
      const { setup } = recordingSetup({ base: 'origin/main', head: 'x', remoteBranch: null });
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
    const { setup, setupCalls } = recordingSetup({ base: 'origin/main', head: 'x', remoteBranch: { sha: 'abc' } });
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
    const { setup } = recordingSetup({ base: 'origin/main', head: 'x', remoteBranch: null });

    const ws = await worktreeWorkspace({
      repoRoot: '/repo',
      branch: 'issue-10',
      worktreePath: '/repo/.worktrees/issue-10',
      setup,
      cleanup: async () => {},
    });

    expect('remoteBranch' in ws).toBe(false);
  });

  it('provisions via injected setup, exposes worktreePath, and tears down via injected cleanup', async () => {
    const { setup, setupCalls } = recordingSetup(undefined);
    const { cleanup, cleanupCalls } = recordingCleanup();
    const log = () => {};

    const ws: Workspace = await worktreeWorkspace({
      repoRoot: '/repo',
      branch: 'issue-1',
      worktreePath: '/repo/.worktrees/issue-1',
      setup,
      cleanup,
      log,
    });

    expect(setupCalls).toEqual([
      ['/repo', 'issue-1', '/repo/.worktrees/issue-1', undefined, undefined, log, { findOpenPr: undefined }],
    ]);
    expect(ws.path).toBe('/repo/.worktrees/issue-1');

    expect(cleanupCalls).toEqual([]);
    await ws.dispose();
    expect(cleanupCalls).toEqual([['/repo', '/repo/.worktrees/issue-1', log, undefined]]);
  });

  it('forwards the sandbox descriptor to both setup and cleanup', async () => {
    const { setup, setupCalls } = recordingSetup(undefined);
    const { cleanup, cleanupCalls } = recordingCleanup();
    const log = () => {};
    const sandbox: WorktreeSandbox = { runtime: 'docker-sandbox', authPaths: ['/home/.claude'], allowHosts: [] };

    const ws: Workspace = await worktreeWorkspace({
      repoRoot: '/repo',
      branch: 'issue-3',
      worktreePath: '/repo/.worktrees/issue-3',
      sandbox,
      setup,
      cleanup,
      log,
    });

    expect(setupCalls).toEqual([
      ['/repo', 'issue-3', '/repo/.worktrees/issue-3', undefined, sandbox, log, { findOpenPr: undefined }],
    ]);

    expect(cleanupCalls).toEqual([]);
    await ws.dispose();
    expect(cleanupCalls).toEqual([['/repo', '/repo/.worktrees/issue-3', log, sandbox]]);
  });

  it('passes an explicit startPoint through to setup verbatim', async () => {
    const { setup, setupCalls } = recordingSetup(undefined);
    const { cleanup } = recordingCleanup();

    await worktreeWorkspace({
      repoRoot: '/repo',
      branch: 'issue-2',
      worktreePath: '/repo/.worktrees/issue-2',
      startPoint: 'origin/develop',
      setup,
      cleanup,
    });

    expect(setupCalls).toEqual([
      [
        '/repo',
        'issue-2',
        '/repo/.worktrees/issue-2',
        'origin/develop',
        undefined,
        undefined,
        { findOpenPr: undefined },
      ],
    ]);
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
