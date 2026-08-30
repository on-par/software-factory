import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { readPortLeases } from '../environment/index.js';
import { ProcessGroupTracker } from '../environment/process-groups.js';
import { createSimWorkspace } from '../sim/index.js';
import type { WorktreeSandbox } from '../utils/microvm.js';
import type { LocalOnlyPolicy } from '../work/local-only.js';
import {
  acquireLaneEnvironment,
  type Environment,
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

describe('localOnlyWorkspace', () => {
  it('wraps a LocalOnlyPolicy as a Workspace using the policy workspace path as-is', async () => {
    const policy: LocalOnlyPolicy = { mode: 'local-only', workspace: '/tmp/some-repo' };
    const ws: Workspace = localOnlyWorkspace(policy);
    expect(ws.path).toBe(policy.workspace);
    await expect(ws.dispose()).resolves.toBeUndefined();
  });
});

describe('simWorkspace', () => {
  it('wraps a SimWorkspace as a Workspace, delegating dispose to the sim', async () => {
    const sim = await createSimWorkspace();
    const ws: Workspace = simWorkspace(sim);
    expect(ws.path).toBe(sim.repoRoot);
    await ws.dispose();
    // Idempotent: disposing a second time (directly through the sim) must not throw.
    await expect(sim.dispose()).resolves.toBeUndefined();
  });
});

describe('worktreeWorkspace', () => {
  it('provisions via injected setup, exposes worktreePath, and tears down via injected cleanup', async () => {
    const setup = vi.fn().mockResolvedValue(undefined);
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const log = vi.fn();

    const ws: Workspace = await worktreeWorkspace({
      repoRoot: '/repo',
      branch: 'issue-1',
      worktreePath: '/repo/.worktrees/issue-1',
      setup,
      cleanup,
      log,
    });

    expect(setup).toHaveBeenCalledWith('/repo', 'issue-1', '/repo/.worktrees/issue-1', 'origin/main', undefined, log);
    expect(ws.path).toBe('/repo/.worktrees/issue-1');

    await ws.dispose();
    expect(cleanup).toHaveBeenCalledWith('/repo', '/repo/.worktrees/issue-1', log, undefined);
  });

  it('forwards the sandbox descriptor to both setup and cleanup', async () => {
    const setup = vi.fn().mockResolvedValue(undefined);
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const log = vi.fn();
    const sandbox: WorktreeSandbox = { runtime: 'docker-sandbox', authPaths: ['/home/.claude'] };

    const ws: Workspace = await worktreeWorkspace({
      repoRoot: '/repo',
      branch: 'issue-3',
      worktreePath: '/repo/.worktrees/issue-3',
      sandbox,
      setup,
      cleanup,
      log,
    });

    expect(setup).toHaveBeenCalledWith('/repo', 'issue-3', '/repo/.worktrees/issue-3', 'origin/main', sandbox, log);

    await ws.dispose();
    expect(cleanup).toHaveBeenCalledWith('/repo', '/repo/.worktrees/issue-3', log, sandbox);
  });

  it('passes an explicit startPoint through to setup instead of the origin/main default', async () => {
    const setup = vi.fn().mockResolvedValue(undefined);
    const cleanup = vi.fn().mockResolvedValue(undefined);

    await worktreeWorkspace({
      repoRoot: '/repo',
      branch: 'issue-2',
      worktreePath: '/repo/.worktrees/issue-2',
      startPoint: 'origin/develop',
      setup,
      cleanup,
    });

    expect(setup).toHaveBeenCalledWith(
      '/repo',
      'issue-2',
      '/repo/.worktrees/issue-2',
      'origin/develop',
      undefined,
      undefined,
    );
  });
});

describe('acquireLaneEnvironment', () => {
  it('bundles port lease + env + pgid tracking + release into one Environment', async () => {
    await withTmpDir(async (dir) => {
      const registryFile = join(dir, 'ports.json');
      const lockDir = join(dir, 'ports.lock');
      const tracker = new ProcessGroupTracker();
      const killAll = vi.spyOn(tracker, 'killAll').mockResolvedValue([]);

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
      // recordLeasePgid persists fire-and-forget; give the microtask queue a tick.
      await new Promise((r) => setTimeout(r, 20));
      const leaseAfterRecord = readPortLeases(registryFile).find((l) => l.worktreeId === '/wt/lane-a');
      expect(leaseAfterRecord?.pgids).toContain(1234);

      await env.release();
      expect(killAll).toHaveBeenCalled();
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
