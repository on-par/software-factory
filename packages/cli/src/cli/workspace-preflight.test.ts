import { describe, expect, it, vi } from 'vitest';

import { loadFactoryConfig } from '@on-par/factory-core';

import {
  dockerWorkspacePreflightError,
  probeDocker,
  statusWorkspaceMode,
  workspaceGate,
} from './workspace-preflight.js';

describe('dockerWorkspacePreflightError', () => {
  it('reports a missing CLI', () => {
    const err = dockerWorkspacePreflightError({ cli: false, daemon: false });
    expect(err).toContain('Docker CLI');
    expect(err).toContain('worktree');
  });
  it('reports an unreachable daemon', () => {
    expect(dockerWorkspacePreflightError({ cli: true, daemon: false })).toContain('Docker daemon is unreachable');
  });
  it('passes when healthy', () => {
    expect(dockerWorkspacePreflightError({ cli: true, daemon: true })).toBeNull();
  });
});

describe('probeDocker', () => {
  it('skips the engine when the CLI is missing', async () => {
    const isAvailable = vi.fn(async () => true);
    expect(await probeDocker({ cliPresent: async () => false, engine: { isAvailable } })).toEqual({
      cli: false,
      daemon: false,
    });
    expect(isAvailable).not.toHaveBeenCalled();
  });
  it('maps engine availability to daemon', async () => {
    const cliPresent = async () => true;
    expect(await probeDocker({ cliPresent, engine: { isAvailable: async () => true } })).toEqual({
      cli: true,
      daemon: true,
    });
    expect(await probeDocker({ cliPresent, engine: { isAvailable: async () => false } })).toEqual({
      cli: true,
      daemon: false,
    });
    expect(
      await probeDocker({
        cliPresent,
        engine: {
          isAvailable: async () => {
            throw new Error('boom');
          },
        },
      }),
    ).toEqual({ cli: true, daemon: false });
  });
  it('treats an engine without isAvailable as unavailable', async () => {
    expect(await probeDocker({ cliPresent: async () => true, engine: {} })).toEqual({ cli: true, daemon: false });
  });
});

describe('workspaceGate', () => {
  const docker = (runtime: 'auto' | 'firejail' = 'auto') => {
    const c = loadFactoryConfig();
    return { ...c, sandbox: { ...c.sandbox, runtime }, workspace: { ...c.workspace, mode: 'docker' as const } };
  };
  it('proceeds in worktree mode without probing', async () => {
    const probe = vi.fn();
    expect(await workspaceGate(loadFactoryConfig(), { env: {}, probe })).toEqual({ kind: 'worktree', warning: null });
    expect(probe).not.toHaveBeenCalled();
  });
  it('reports an invalid env value', async () => {
    const g = await workspaceGate(loadFactoryConfig(), { env: { FACTORY_WORKSPACE_MODE: 'vm' } });
    expect(g.kind).toBe('invalid');
  });
  it('fails closed when docker is down, with the sandbox warning', async () => {
    const g = await workspaceGate(docker('firejail'), { env: {}, probe: async () => ({ cli: true, daemon: false }) });
    expect(g).toMatchObject({ kind: 'preflight-failed' });
    expect((g as { warning: string }).warning).toContain('ignored');
  });
  it('stops before claiming when docker is healthy', async () => {
    const g = await workspaceGate(docker(), { env: {}, probe: async () => ({ cli: true, daemon: true }) });
    expect(g).toMatchObject({ kind: 'docker-unavailable', warning: null });
  });
});

describe('statusWorkspaceMode', () => {
  it('falls back to worktree on an invalid env value', () => {
    const prev = process.env.FACTORY_WORKSPACE_MODE;
    process.env.FACTORY_WORKSPACE_MODE = 'vm';
    try {
      expect(statusWorkspaceMode(loadFactoryConfig())).toEqual({ mode: 'worktree', source: 'default' });
    } finally {
      if (prev === undefined) delete process.env.FACTORY_WORKSPACE_MODE;
      else process.env.FACTORY_WORKSPACE_MODE = prev;
    }
  });
});

describe('probeDocker default CLI check', () => {
  it('never throws and returns booleans', async () => {
    const r = await probeDocker({ engine: { isAvailable: async () => false } });
    expect(typeof r.cli).toBe('boolean');
    expect(r.daemon).toBe(false);
  });
});
