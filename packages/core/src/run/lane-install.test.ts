import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createTempDirs } from '@on-par/factory-core/testing';
import { afterAll, describe, expect, it, vi } from 'vitest';

import type { SandboxPolicy } from '../sandbox/index.js';
import type { CommandResult } from '../utils/command-runner.js';
import { installLaneDependencies } from './lane-install.js';

const dirs = createTempDirs();
afterAll(() => dirs.cleanup());

async function worktree(...files: string[]): Promise<string> {
  const dir = await dirs.make('lane-install-');
  for (const f of files) await writeFile(join(dir, f), '');
  return dir;
}

function result(over: Partial<CommandResult> = {}): CommandResult {
  return { command: [], stdout: '', stderr: '', exitCode: 0, killed: false, timedOut: false, ok: true, ...over };
}

describe('installLaneDependencies', () => {
  it('runs no install when the worktree has no package.json', async () => {
    const runCommand = vi.fn();
    const log = vi.fn();
    const r = await installLaneDependencies({ worktree: await worktree(), env: {}, log, runCommand });
    expect(r).toEqual({ status: 'skipped', reason: 'no package.json' });
    expect(runCommand).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('lane_install', 'skipped: no package.json');
  });

  it('skips when node_modules already exists', async () => {
    const wt = await worktree('package.json');
    await mkdir(join(wt, 'node_modules'));
    const runCommand = vi.fn();
    const log = vi.fn();
    const r = await installLaneDependencies({ worktree: wt, env: {}, log, runCommand });
    expect(r).toEqual({ status: 'skipped', reason: 'node_modules already present' });
    expect(runCommand).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('lane_install', 'skipped: node_modules already present');
  });

  it('skips in a docker-sandbox micro-VM', async () => {
    const runCommand = vi.fn();
    const sandbox = { runtime: 'docker-sandbox' } as SandboxPolicy;
    const r = await installLaneDependencies({
      worktree: await worktree('package.json'),
      env: {},
      log: vi.fn(),
      sandbox,
      runCommand,
    });
    expect(r).toEqual({ status: 'skipped', reason: 'micro-VM sandbox' });
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('skips a local-only workspace', async () => {
    const runCommand = vi.fn();
    const r = await installLaneDependencies({
      worktree: await worktree('package.json'),
      env: {},
      log: vi.fn(),
      localOnly: true,
      runCommand,
    });
    expect(r).toEqual({ status: 'skipped', reason: 'local-only workspace' });
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('runs the frozen install in the worktree with the lane env and logs the command and duration', async () => {
    const wt = await worktree('package.json', 'pnpm-lock.yaml');
    const runCommand = vi.fn(async () => result());
    const log = vi.fn();
    const env = { PORT: '3101' };
    const onPgid = vi.fn();
    const times = [1000, 1250];
    const r = await installLaneDependencies({
      worktree: wt,
      env,
      log,
      onPgid,
      runCommand,
      now: () => times.shift() ?? 0,
    });
    expect(runCommand).toHaveBeenCalledWith(['pnpm', 'install', '--frozen-lockfile'], {
      cwd: wt,
      env,
      timeoutMs: 600000,
      onPgid,
    });
    expect(r).toEqual({ status: 'installed', command: ['pnpm', 'install', '--frozen-lockfile'], durationMs: 250 });
    expect(log).toHaveBeenCalledWith('lane_install', 'pnpm install --frozen-lockfile (250ms)');
  });

  it('logs lane_install_failed with the command and only the last 300 chars of output on a non-zero exit', async () => {
    const wt = await worktree('package.json', 'package-lock.json');
    const stderr = `HEAD${'x'.repeat(400)}TAIL`;
    const runCommand = vi.fn(async () => result({ ok: false, exitCode: 1, stderr }));
    const log = vi.fn();
    const r = await installLaneDependencies({ worktree: wt, env: {}, log, runCommand });
    expect(r.status).toBe('failed');
    const msg = log.mock.calls[0][1] as string;
    expect(log.mock.calls[0][0]).toBe('lane_install_failed');
    expect(msg).toContain('npm ci --no-audit --no-fund');
    expect(msg).toContain('TAIL');
    expect(msg).not.toContain('HEAD');
    expect(r.status === 'failed' && r.output).toHaveLength(300);
  });

  it('marks a timeout in the failure output', async () => {
    const runCommand = vi.fn(async () => result({ ok: false, timedOut: true, killed: true, exitCode: -1 }));
    const r = await installLaneDependencies({
      worktree: await worktree('package.json'),
      env: {},
      log: vi.fn(),
      runCommand,
    });
    expect(r).toMatchObject({ status: 'failed', output: 'timed out after 600s: ' });
  });

  it('returns failed instead of throwing when runCommand rejects', async () => {
    const runCommand = vi.fn(async () => {
      throw new Error('spawn ENOENT');
    });
    const log = vi.fn();
    const r = await installLaneDependencies({ worktree: await worktree('package.json'), env: {}, log, runCommand });
    expect(r).toMatchObject({ status: 'failed', output: 'spawn ENOENT' });
    expect(log).toHaveBeenCalledWith('lane_install_failed', expect.stringContaining('spawn ENOENT'));
  });
});
