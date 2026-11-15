import { describe, expect, it } from 'vitest';

import { recordingLog, type LoggedEvent } from '../test-support/recorders.js';

import type { ExecFn } from './exec.js';
import {
  createMicroVm,
  listMicroVms,
  type MicroVmLifecycleOptions,
  microVmName,
  reapOrphanMicroVm,
  removeMicroVm,
  worktreeSandboxFor,
} from './microvm.js';

const logRecorder = () => {
  const events: LoggedEvent[] = [];
  return { events, log: recordingLog(events) };
};

function makeExec(impl: (cmd: string) => Promise<{ stdout: string; stderr: string }>) {
  const calls: [string, unknown][] = [];
  const exec: ExecFn = (async (cmd, opts) => {
    calls.push([cmd, opts]);
    return impl(cmd);
  }) as ExecFn;
  return { exec, calls };
}

const OK_EXEC = makeExec(async () => ({ stdout: '', stderr: '' })).exec;

function baseOpts(overrides: Partial<MicroVmLifecycleOptions> = {}): MicroVmLifecycleOptions {
  return {
    runtime: 'docker-sandbox',
    authPaths: ['/home/user/.claude', '/home/user/.codex', '/home/user/.npm'],
    allowHosts: ['api.anthropic.com', 'github.com'],
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

  it('builds authPaths for ~/.claude, ~/.codex, ~/.npm under the given home, with an empty allowlist by default', () => {
    expect(worktreeSandboxFor('docker-sandbox', { homedir: '/home/user', env: {} })).toEqual({
      runtime: 'docker-sandbox',
      authPaths: ['/home/user/.claude', '/home/user/.codex', '/home/user/.npm'],
      allowHosts: [],
    });
  });

  it('also mounts the CLAUDE_CONFIG_DIR profile when set, alongside ~/.claude', () => {
    expect(
      worktreeSandboxFor('docker-sandbox', {
        homedir: '/home/user',
        env: { CLAUDE_CONFIG_DIR: '/home/user/.claude-work' },
      })?.authPaths,
    ).toEqual(['/home/user/.claude', '/home/user/.claude-work', '/home/user/.codex', '/home/user/.npm']);
  });

  it('carries the given allowHosts on the descriptor', () => {
    expect(
      worktreeSandboxFor('docker-sandbox', {
        homedir: '/home/user',
        allowHosts: ['api.anthropic.com', 'github.com'],
        env: {},
      }),
    ).toEqual({
      runtime: 'docker-sandbox',
      authPaths: ['/home/user/.claude', '/home/user/.codex', '/home/user/.npm'],
      allowHosts: ['api.anthropic.com', 'github.com'],
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
  it('issues a pre-clean sbx rm, then sbx create with the worktree as writable root plus one --mount per auth path', async () => {
    const { exec, calls } = makeExec(async () => ({ stdout: '', stderr: '' }));

    const { events, log } = logRecorder();
    const created = await createMicroVm(baseOpts({ exec, log }));

    expect(created).toBe(true);
    const cmds = calls.map(([cmd]) => cmd);
    const name = microVmName('/repo/.worktrees/653');
    expect(cmds).toEqual([
      `sbx rm --force ${name}`,
      `sbx create --name ${name} --mount '/repo/.worktrees/653':rw --mount '/home/user/.claude':rw --mount '/home/user/.codex':rw --mount '/home/user/.npm':rw --allow-network 'api.anthropic.com' --allow-network 'github.com'`,
    ]);
    expect(events).toContainEqual(expect.objectContaining({ type: 'sandbox', msg: expect.stringContaining(name) }));
  });

  it('renders --network none when the allowlist is empty', async () => {
    const { exec, calls } = makeExec(async () => ({ stdout: '', stderr: '' }));

    await createMicroVm(baseOpts({ exec, allowHosts: [] }));

    const createCall = calls.map(([cmd]) => cmd).find((cmd) => cmd.includes('sbx create')) ?? '';
    expect(createCall).toMatch(/--network none$/);
    expect(createCall).not.toContain('--allow-network');
  });

  it('returns false and issues no create when sbx is not installed', async () => {
    const { exec, calls } = makeExec(async () => ({ stdout: '', stderr: '' }));

    const { events, log } = logRecorder();
    const created = await createMicroVm(baseOpts({ exec, isAvailable: () => false, log }));

    expect(created).toBe(false);
    expect(calls).toEqual([]);
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'sandbox-unavailable', msg: expect.stringContaining('sbx not installed') }),
    );
  });

  it('returns false and issues no exec for non-docker-sandbox runtimes', async () => {
    const { exec, calls } = makeExec(async () => ({ stdout: '', stderr: '' }));

    for (const runtime of ['sandbox-exec', 'firejail', 'none'] as const) {
      const created = await createMicroVm(baseOpts({ exec, runtime }));
      expect(created).toBe(false);
    }
    expect(calls).toEqual([]);
  });

  it('does not throw and returns false when exec rejects', async () => {
    const { exec } = makeExec(async (cmd: string) => {
      if (cmd.includes('sbx create')) throw new Error('sbx create failed');
      return { stdout: '', stderr: '' };
    });

    const { events, log } = logRecorder();
    await expect(createMicroVm(baseOpts({ exec, log }))).resolves.toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'sandbox-unavailable', msg: expect.stringContaining('sbx create failed') }),
    );
  });

  it('best-effort removes a stale VM of the same name before creating', async () => {
    const { exec, calls } = makeExec(async () => ({ stdout: '', stderr: '' }));

    await createMicroVm(baseOpts({ exec }));

    expect(calls[0]?.[0]).toContain('sbx rm --force');
    expect(calls[1]?.[0]).toContain('sbx create');
  });
});

describe('removeMicroVm', () => {
  it('issues sbx rm --force <name>', async () => {
    const { exec, calls } = makeExec(async () => ({ stdout: '', stderr: '' }));
    const name = microVmName('/repo/.worktrees/653');

    const { events, log } = logRecorder();
    await removeMicroVm(baseOpts({ exec, log }));

    expect(calls).toEqual([[`sbx rm --force ${name}`, expect.objectContaining({ timeoutMs: expect.any(Number) })]]);
    expect(events).toContainEqual(expect.objectContaining({ type: 'sandbox', msg: expect.stringContaining(name) }));
  });

  it('resolves (swallows) when exec rejects', async () => {
    const { exec } = makeExec(async () => {
      throw new Error('vm not found');
    });

    await expect(removeMicroVm(baseOpts({ exec }))).resolves.toBeUndefined();
  });

  it('issues nothing when sbx is not installed', async () => {
    const { exec, calls } = makeExec(async () => ({ stdout: '', stderr: '' }));

    await removeMicroVm(baseOpts({ exec, isAvailable: () => false }));

    expect(calls).toEqual([]);
  });

  it('is a no-op for non-docker-sandbox runtimes', async () => {
    const { exec, calls } = makeExec(async () => ({ stdout: '', stderr: '' }));

    await removeMicroVm(baseOpts({ exec, runtime: 'none' }));

    expect(calls).toEqual([]);
  });
});

describe('listMicroVms', () => {
  it('returns [] when sbx is not installed', async () => {
    const { exec, calls } = makeExec(async () => ({ stdout: 'factory-abc123\n', stderr: '' }));

    const names = await listMicroVms({ exec, isAvailable: () => false });

    expect(names).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('returns [] when exec rejects', async () => {
    const { exec } = makeExec(async () => {
      throw new Error('sbx list failed');
    });

    await expect(listMicroVms({ exec, isAvailable: () => true })).resolves.toEqual([]);
  });

  it('keeps only lines whose first token starts with factory-', async () => {
    const { exec } = makeExec(async () => ({
      stdout: 'factory-abc123   running\nother-vm   running\nfactory-def456   stopped\n\n',
      stderr: '',
    }));

    const names = await listMicroVms({ exec, isAvailable: () => true });

    expect(names).toEqual(['factory-abc123', 'factory-def456']);
  });

  it('issues sbx list', async () => {
    const { exec, calls } = makeExec(async () => ({ stdout: '', stderr: '' }));

    await listMicroVms({ exec, isAvailable: () => true });

    expect(calls).toEqual([['sbx list', expect.objectContaining({ timeoutMs: expect.any(Number) })]]);
  });
});

describe('reapOrphanMicroVm', () => {
  it('issues sbx rm --force <name> and returns removed: true on success', async () => {
    const { exec, calls } = makeExec(async () => ({ stdout: '', stderr: '' }));

    const result = await reapOrphanMicroVm('factory-abc123', { exec });

    expect(calls).toEqual([
      ["sbx rm --force 'factory-abc123'", expect.objectContaining({ timeoutMs: expect.any(Number) })],
    ]);
    expect(result).toEqual({ name: 'factory-abc123', removed: true, detail: 'sbx rm --force factory-abc123 ok' });
  });

  it('returns removed: false with the error text (never throws) when exec rejects', async () => {
    const { exec } = makeExec(async () => {
      const err = Object.assign(new Error('vm not found'), { stderr: 'no such vm' });
      throw err;
    });

    const result = await reapOrphanMicroVm('factory-abc123', { exec });

    expect(result).toEqual({
      name: 'factory-abc123',
      removed: false,
      detail: 'sbx rm --force factory-abc123 failed: no such vm',
    });
  });
});
