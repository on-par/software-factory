import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { loadFactoryConfig } from '@on-par/factory-core';

import {
  applyWorkspaceGate,
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
  const engine = { isAvailable: async () => true };
  const withPath = async (dir: string, fn: () => Promise<void>) => {
    const prev = process.env.PATH;
    process.env.PATH = dir;
    try {
      await fn();
    } finally {
      process.env.PATH = prev;
    }
  };

  it('reports the CLI missing when docker is not on PATH', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wsp-empty-'));
    await withPath(dir, async () => {
      expect(await probeDocker({ engine })).toEqual({ cli: false, daemon: false });
    });
  });

  it('reports the CLI present when `docker --version` succeeds', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wsp-fake-'));
    writeFileSync(join(dir, 'docker'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(dir, 'docker'), 0o755);
    await withPath(dir, async () => {
      expect(await probeDocker({ engine })).toEqual({ cli: true, daemon: true });
    });
  });
});

describe('applyWorkspaceGate', () => {
  const mk = () => {
    const calls: string[] = [];
    const io = {
      warn: (m: string) => calls.push(`warn:${m}`),
      info: (m: string) => calls.push(`info:${m}`),
      event: (k: string, m: string) => calls.push(`${k}:${m}`),
      invalid: (m: string) => new Error(`invalid:${m}`),
    };
    return { calls, io: io as Parameters<typeof applyWorkspaceGate>[1] };
  };
  const dockerCfg = () => {
    const c = loadFactoryConfig();
    return {
      ...c,
      sandbox: { ...c.sandbox, runtime: 'firejail' as const },
      workspace: { ...c.workspace, mode: 'docker' as const },
    };
  };

  it('proceeds in worktree mode', async () => {
    const { io, calls } = mk();
    expect(await applyWorkspaceGate(loadFactoryConfig(), io, { env: {} })).toBe(true);
    expect(calls).toEqual([]);
  });
  it('throws via io.invalid for a bad env value', async () => {
    const { io } = mk();
    await expect(
      applyWorkspaceGate(loadFactoryConfig(), io, { env: { FACTORY_WORKSPACE_MODE: 'vm' } }),
    ).rejects.toThrow(/^invalid:/);
  });
  it('logs and throws when docker preflight fails', async () => {
    const { io, calls } = mk();
    await expect(
      applyWorkspaceGate(dockerCfg(), io, { env: {}, probe: async () => ({ cli: false, daemon: false }) }),
    ).rejects.toThrow(/Docker CLI/);
    expect(calls.some((c) => c.startsWith('environment_warning:'))).toBe(true);
    expect(calls.some((c) => c.startsWith('warn:'))).toBe(true);
  });
  it('stops without claiming when docker is healthy', async () => {
    const { io, calls } = mk();
    expect(
      await applyWorkspaceGate(dockerCfg(), io, { env: {}, probe: async () => ({ cli: true, daemon: true }) }),
    ).toBe(false);
    expect(calls.some((c) => c.startsWith('stopped:'))).toBe(true);
    expect(calls.some((c) => c.startsWith('info:'))).toBe(true);
  });
});
