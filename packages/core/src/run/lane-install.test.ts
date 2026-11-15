import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createTempDirs } from '@on-par/factory-core/testing';
import { afterAll, describe, expect, it } from 'vitest';

import { recordArgs } from '../test-support/recorders.js';
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
    const runs = recordArgs(async (..._a: unknown[]) => result());
    const logs = recordArgs((_t: string, _m: string) => {});
    const r = await installLaneDependencies({ worktree: await worktree(), env: {}, log: logs.fn, runCommand: runs.fn });
    expect(r).toEqual({ status: 'skipped', reason: 'no package.json' });
    expect(runs.calls).toEqual([]);
    expect(logs.calls).toEqual([['lane_install', 'skipped: no package.json']]);
  });

  it('skips when node_modules already exists', async () => {
    const wt = await worktree('package.json');
    await mkdir(join(wt, 'node_modules'));
    const runs = recordArgs(async (..._a: unknown[]) => result());
    const logs = recordArgs((_t: string, _m: string) => {});
    const r = await installLaneDependencies({ worktree: wt, env: {}, log: logs.fn, runCommand: runs.fn });
    expect(r).toEqual({ status: 'skipped', reason: 'node_modules already present' });
    expect(runs.calls).toEqual([]);
    expect(logs.calls).toEqual([['lane_install', 'skipped: node_modules already present']]);
  });

  it('an in-place checkout with node_modules skips the install and runs no command', async () => {
    const wt = await worktree('package.json', 'package-lock.json');
    await mkdir(join(wt, 'node_modules'));
    const runs = recordArgs(async (..._a: unknown[]) => result());
    const r = await installLaneDependencies({ worktree: wt, env: {}, log: () => {}, runCommand: runs.fn });
    expect(r).toEqual({ status: 'skipped', reason: 'node_modules already present' });
    expect(runs.calls).toEqual([]);
  });

  it('skips in a docker-sandbox micro-VM', async () => {
    const runs = recordArgs(async (..._a: unknown[]) => result());
    const sandbox = { runtime: 'docker-sandbox' } as SandboxPolicy;
    const r = await installLaneDependencies({
      worktree: await worktree('package.json'),
      env: {},
      log: () => {},
      sandbox,
      runCommand: runs.fn,
    });
    expect(r).toEqual({ status: 'skipped', reason: 'micro-VM sandbox' });
    expect(runs.calls).toEqual([]);
  });

  it('skips a local-only workspace', async () => {
    const runs = recordArgs(async (..._a: unknown[]) => result());
    const r = await installLaneDependencies({
      worktree: await worktree('package.json'),
      env: {},
      log: () => {},
      localOnly: true,
      runCommand: runs.fn,
    });
    expect(r).toEqual({ status: 'skipped', reason: 'local-only workspace' });
    expect(runs.calls).toEqual([]);
  });

  it('runs the frozen install in the worktree with the lane env and logs the command and duration', async () => {
    const wt = await worktree('package.json', 'pnpm-lock.yaml');
    const runs = recordArgs(async (..._a: unknown[]) => result());
    const logs = recordArgs((_t: string, _m: string) => {});
    const env = { PORT: '3101' };
    const onPgid = () => {};
    const times = [1000, 1250];
    const r = await installLaneDependencies({
      worktree: wt,
      env,
      log: logs.fn,
      onPgid,
      runCommand: runs.fn,
      now: () => times.shift() ?? 0,
    });
    expect(runs.calls).toEqual([
      [['pnpm', 'install', '--frozen-lockfile'], { cwd: wt, env, timeoutMs: 600000, onPgid }],
    ]);
    expect(r).toEqual({ status: 'installed', command: ['pnpm', 'install', '--frozen-lockfile'], durationMs: 250 });
    expect(logs.calls).toEqual([['lane_install', 'pnpm install --frozen-lockfile (250ms)']]);
  });

  it('logs lane_install_failed with the command and only the last 300 chars of output on a non-zero exit', async () => {
    const wt = await worktree('package.json', 'package-lock.json');
    const stderr = `HEAD${'x'.repeat(400)}TAIL`;
    const runCommand = async () => result({ ok: false, exitCode: 1, stderr });
    const logs = recordArgs((_t: string, _m: string) => {});
    const r = await installLaneDependencies({ worktree: wt, env: {}, log: logs.fn, runCommand });
    expect(r.status).toBe('failed');
    const [type, msg] = logs.calls[0] ?? ['', ''];
    expect(type).toBe('lane_install_failed');
    expect(msg).toContain('npm ci --no-audit --no-fund');
    expect(msg).toContain('TAIL');
    expect(msg).not.toContain('HEAD');
    expect(r.status === 'failed' && r.output).toHaveLength(300);
  });

  it('marks a timeout in the failure output', async () => {
    const runCommand = async () => result({ ok: false, timedOut: true, killed: true, exitCode: -1 });
    const r = await installLaneDependencies({
      worktree: await worktree('package.json'),
      env: {},
      log: () => {},
      runCommand,
    });
    expect(r).toMatchObject({ status: 'failed', output: 'timed out after 600s: ' });
  });

  it('returns failed instead of throwing when runCommand rejects', async () => {
    const runCommand = async (): Promise<CommandResult> => Promise.reject(new Error('spawn ENOENT'));
    const { calls, fn: log } = recordArgs((_t: string, _m: string) => {});
    const r = await installLaneDependencies({ worktree: await worktree('package.json'), env: {}, log, runCommand });
    expect(r).toMatchObject({ status: 'failed', output: 'spawn ENOENT' });
    expect(calls).toContainEqual(['lane_install_failed', expect.stringContaining('spawn ENOENT')]);
  });
});
