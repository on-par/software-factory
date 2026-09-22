import { describe, expect, it, vi } from 'vitest';

import type { WorktreeSandbox } from '../utils/microvm.js';
import type { LocalOnlyPolicy } from '../work/local-only.js';
import { localOnlyWorkspace, type Workspace, worktreeWorkspace } from './ports.js';

describe('localOnlyWorkspace', () => {
  it('wraps a LocalOnlyPolicy as a Workspace using the policy workspace path as-is', async () => {
    const policy: LocalOnlyPolicy = { mode: 'local-only', workspace: '/tmp/some-repo' };
    const ws: Workspace = localOnlyWorkspace(policy);
    expect(ws.path).toBe(policy.workspace);
    await expect(ws.dispose()).resolves.toBeUndefined();
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

    expect(setup).toHaveBeenCalledWith('/repo', 'issue-1', '/repo/.worktrees/issue-1', undefined, undefined, log);
    expect(ws.path).toBe('/repo/.worktrees/issue-1');

    await ws.dispose();
    expect(cleanup).toHaveBeenCalledWith('/repo', '/repo/.worktrees/issue-1', log, undefined);
  });

  it('forwards the sandbox descriptor to both setup and cleanup', async () => {
    const setup = vi.fn().mockResolvedValue(undefined);
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const log = vi.fn();
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

    expect(setup).toHaveBeenCalledWith('/repo', 'issue-3', '/repo/.worktrees/issue-3', undefined, sandbox, log);

    await ws.dispose();
    expect(cleanup).toHaveBeenCalledWith('/repo', '/repo/.worktrees/issue-3', log, sandbox);
  });

  it('passes an explicit startPoint through to setup verbatim', async () => {
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
