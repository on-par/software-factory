import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { recordArgs } from '../test-support/recorders.js';
import type { KillOutcome } from '../environment/process-groups.js';
import { createDefaultExecFn, type ExecDeps } from './exec.js';

function fakeChild(pid: number | undefined) {
  const child = Object.assign(new EventEmitter(), {
    pid,
    killed: false,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: () => {
      child.killed = true;
      return true;
    },
  });
  return child;
}

function setup(pid: number | null = 4242) {
  const child = fakeChild(pid ?? undefined);
  const spawn: NonNullable<ExecDeps['spawn']> = () => child as never;
  const { calls: killCalls, fn: killProcessGroup } = recordArgs(
    async (_pgid: number, _opts?: unknown) => ({}) as KillOutcome,
  );
  const { calls: pgids, fn: onPgid } = recordArgs((_pgid: number) => undefined);
  const exec = createDefaultExecFn({ spawn, killProcessGroup });
  const run = (opts: Parameters<typeof exec>[1] = {}) =>
    exec('cmd', { ...opts, env: { FACTORY_DAEMON_GROUPS_FILE: '' }, onPgid });
  return { child, killCalls, pgids, run };
}

describe('createDefaultExecFn detached path (fake child)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  for (const stream of ['stdout', 'stderr'] as const) {
    it(`rejects and kills the child when ${stream} exceeds maxBuffer`, async () => {
      const { child, killCalls, run } = setup();
      const result = run({ maxBuffer: 4 }).catch((e) => e);
      child[stream].emit('data', Buffer.from('12345'));
      child.emit('exit', null, 'SIGTERM');
      const err = await result;
      expect(child.killed).toBe(true);
      expect(err.message).toBe('stdout/stderr maxBuffer exceeded');
      expect(err.killed).toBe(true);
      expect(err[stream]).toBe('');
      expect(killCalls).toEqual([[4242, { graceMs: undefined }]]);
    });
  }

  it('rejects on a child error event and clears the timeout timer', async () => {
    vi.useFakeTimers();
    const { child, killCalls, run } = setup();
    const result = run({ timeoutMs: 1000 }).catch((e) => e);
    child.emit('error', new Error('spawn ENOENT'));
    const err = await result;
    expect(err.message).toBe('spawn ENOENT');
    expect(killCalls).toEqual([]);
    vi.advanceTimersByTime(2000);
    expect(child.killed).toBe(false);
  });

  it('sets no timer when timeoutMs is absent', async () => {
    vi.useFakeTimers();
    const { child, run } = setup();
    const result = run();
    vi.advanceTimersByTime(10 * 60_000);
    expect(child.killed).toBe(false);
    child.stdout.emit('data', Buffer.from('ok'));
    child.emit('exit', 0, null);
    await expect(result).resolves.toEqual({ stdout: 'ok', stderr: '' });
  });

  it('skips pgid reporting and the group sweep when the child has no pid', async () => {
    const { child, killCalls, pgids, run } = setup(null);
    const result = run().catch((e) => e);
    child.emit('exit', null, 'SIGKILL');
    const err = await result;
    expect(err.signal).toBe('SIGKILL');
    expect(pgids).toEqual([]);
    expect(killCalls).toEqual([]);
  });

  it('sweeps the group when the child exits by signal without being killed', async () => {
    const { child, killCalls, pgids, run } = setup();
    const result = run({ killGraceMs: 50 }).catch((e) => e);
    child.emit('exit', null, 'SIGTERM');
    const err = await result;
    expect(err.killed).toBe(false);
    expect(err.signal).toBe('SIGTERM');
    expect(pgids).toEqual([[4242]]);
    expect(killCalls).toEqual([[4242, { graceMs: 50 }]]);
  });

  it('does not sweep the group on a plain non-zero exit', async () => {
    const { child, killCalls, run } = setup();
    const result = run().catch((e) => e);
    child.emit('exit', 3, null);
    const err = await result;
    expect(err.code).toBe(3);
    expect(killCalls).toEqual([]);
  });
});

describe('createDefaultExecFn onStdout without onPgid', () => {
  it('streams stdout chunks when onStdout is set without onPgid', async () => {
    const child = fakeChild(4242);
    const spawn: NonNullable<ExecDeps['spawn']> = () => child as never;
    const exec = createDefaultExecFn({ spawn });
    const chunks: string[] = [];
    const result = exec('cmd', {
      env: { FACTORY_DAEMON_GROUPS_FILE: '' },
      onStdout: (chunk) => chunks.push(chunk),
    });
    child.stdout.emit('data', Buffer.from('one\n'));
    child.stdout.emit('data', Buffer.from('two\n'));
    expect(chunks).toEqual(['one\n', 'two\n']);
    child.emit('exit', 0, null);
    child.emit('close', 0, null);
    expect((await result).stdout).toBe('one\ntwo\n');
  });
});
