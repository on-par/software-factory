import { describe, expect, it, vi } from 'vitest';

import type { ExecFn } from './exec.js';
import {
  createMicroVm,
  type MicroVmLifecycleOptions,
  microVmName,
  removeMicroVm,
  worktreeSandboxFor,
} from './microvm.js';

function makeExec(impl: (cmd: string) => Promise<{ stdout: string; stderr: string }>): ExecFn {
  return vi.fn(impl);
}

const OK_EXEC = makeExec(async () => ({ stdout: '', stderr: '' }));

function baseOpts(overrides: Partial<MicroVmLifecycleOptions> = {}): MicroVmLifecycleOptions {
  return {
    runtime: 'docker-sandbox',
    authPaths: ['/home/user/.claude', '/home/user/.codex', '/home/user/.npm'],
    worktreePath: '/repo/.worktrees/653',
    isAvailable: () => true,
    exec: OK_EXEC,
    ...overrides,
  };
}

describe('worktreeSandboxFor', () => {
  it('returns undefined for every runtime but docker-sandbox', () => {
    expect(worktreeSandboxFor('sandbox-exec')).toBeUndefined();
    expect(worktreeSandboxFor('firejail')).toBeUndefined();
    expect(worktreeSandboxFor('none')).toBeUndefined();
    expect(worktreeSandboxFor(undefined)).toBeUndefined();
  });

  it('builds authPaths for ~/.claude, ~/.codex, ~/.npm under the given home', () => {
    expect(worktreeSandboxFor('docker-sandbox', { homedir: '/home/user' })).toEqual({
      runtime: 'docker-sandbox',
      authPaths: ['/home/user/.claude', '/home/user/.codex', '/home/user/.npm'],
    });
  });
});

describe('microVmName', () => {
  it('is deterministic for the same worktree path', () => {
    expect(microVmName('/repo/.worktrees/653')).toBe(microVmName('/repo/.worktrees/653'));
  });

  it('differs for two distinct worktree paths', () => {
    expect(microVmName('/repo/.worktrees/653')).not.toBe(microVmName('/repo/.worktrees/654'));
  });

  it('is name-safe (factory-<12 hex chars>)', () => {
    expect(microVmName('/repo/.worktrees/653')).toMatch(/^factory-[0-9a-f]{12}$/);
  });
});

describe('createMicroVm', () => {
  it('issues sbx create with the worktree as writable root plus one --mount per auth path', async () => {
    const exec = makeExec(async () => ({ stdout: '', stderr: '' }));
    const log = vi.fn();

    const created = await createMicroVm(baseOpts({ exec, log }));

    expect(created).toBe(true);
    expect(exec).toHaveBeenCalledTimes(2); // pre-clean rm + create
    const createCall = (exec as any).mock.calls.find(([cmd]: [string]) => cmd.includes('sbx create'))[0];
    const name = microVmName('/repo/.worktrees/653');
    expect(createCall).toBe(
      `sbx create --name ${name} --mount '/repo/.worktrees/653':rw --mount '/home/user/.claude':rw --mount '/home/user/.codex':rw --mount '/home/user/.npm':rw`,
    );
    expect(log).toHaveBeenCalledWith('sandbox', expect.stringContaining(name));
  });

  it('returns false and issues no create when sbx is not installed', async () => {
    const exec = makeExec(async () => ({ stdout: '', stderr: '' }));
    const log = vi.fn();

    const created = await createMicroVm(baseOpts({ exec, isAvailable: () => false, log }));

    expect(created).toBe(false);
    expect(exec).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('sandbox-unavailable', expect.stringContaining('sbx not installed'));
  });

  it('returns false and issues no exec for non-docker-sandbox runtimes', async () => {
    const exec = makeExec(async () => ({ stdout: '', stderr: '' }));

    for (const runtime of ['sandbox-exec', 'firejail', 'none'] as const) {
      const created = await createMicroVm(baseOpts({ exec, runtime }));
      expect(created).toBe(false);
    }
    expect(exec).not.toHaveBeenCalled();
  });

  it('does not throw and returns false when exec rejects', async () => {
    const exec = makeExec(async (cmd: string) => {
      if (cmd.includes('sbx create')) throw new Error('sbx create failed');
      return { stdout: '', stderr: '' };
    });
    const log = vi.fn();

    await expect(createMicroVm(baseOpts({ exec, log }))).resolves.toBe(false);
    expect(log).toHaveBeenCalledWith('sandbox-unavailable', expect.stringContaining('sbx create failed'));
  });

  it('best-effort removes a stale VM of the same name before creating', async () => {
    const calls: string[] = [];
    const exec = makeExec(async (cmd: string) => {
      calls.push(cmd);
      return { stdout: '', stderr: '' };
    });

    await createMicroVm(baseOpts({ exec }));

    expect(calls[0]).toContain('sbx rm --force');
    expect(calls[1]).toContain('sbx create');
  });
});

describe('removeMicroVm', () => {
  it('issues sbx rm --force <name>', async () => {
    const exec = makeExec(async () => ({ stdout: '', stderr: '' }));
    const log = vi.fn();
    const name = microVmName('/repo/.worktrees/653');

    await removeMicroVm(baseOpts({ exec, log }));

    expect(exec).toHaveBeenCalledWith(
      `sbx rm --force ${name}`,
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
    expect(log).toHaveBeenCalledWith('sandbox', expect.stringContaining(name));
  });

  it('resolves (swallows) when exec rejects', async () => {
    const exec = makeExec(async () => {
      throw new Error('vm not found');
    });

    await expect(removeMicroVm(baseOpts({ exec }))).resolves.toBeUndefined();
  });

  it('issues nothing when sbx is not installed', async () => {
    const exec = makeExec(async () => ({ stdout: '', stderr: '' }));

    await removeMicroVm(baseOpts({ exec, isAvailable: () => false }));

    expect(exec).not.toHaveBeenCalled();
  });

  it('is a no-op for non-docker-sandbox runtimes', async () => {
    const exec = makeExec(async () => ({ stdout: '', stderr: '' }));

    await removeMicroVm(baseOpts({ exec, runtime: 'none' }));

    expect(exec).not.toHaveBeenCalled();
  });
});
