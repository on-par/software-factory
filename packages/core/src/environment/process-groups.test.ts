import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  defaultIsProcessGroupAlive,
  killProcessGroup,
  ProcessGroupTracker,
  type TaskkillResult,
} from './process-groups.js';

const noopSleep = async () => {};

describe('defaultIsProcessGroupAlive', () => {
  it('returns false when the group is gone (ESRCH)', () => {
    const killFn = vi.fn(() => {
      const err: any = new Error('no such process');
      err.code = 'ESRCH';
      throw err;
    });
    const original = process.kill;
    (process as any).kill = killFn;
    try {
      expect(defaultIsProcessGroupAlive(999999)).toBe(false);
    } finally {
      process.kill = original;
    }
  });

  it('returns true when alive but not ours (EPERM)', () => {
    const original = process.kill;
    (process as any).kill = () => {
      const err: any = new Error('not permitted');
      err.code = 'EPERM';
      throw err;
    };
    try {
      expect(defaultIsProcessGroupAlive(1)).toBe(true);
    } finally {
      process.kill = original;
    }
  });

  it('returns true when the signal-0 probe succeeds', () => {
    const original = process.kill;
    (process as any).kill = () => undefined;
    try {
      expect(defaultIsProcessGroupAlive(123)).toBe(true);
    } finally {
      process.kill = original;
    }
  });
});

describe('defaultIsProcessGroupAlive platform probe', () => {
  it.each([
    ['win32', 123],
    ['linux', -123],
  ] as const)('probes the right target on %s', (platform, expected) => {
    const killFn = vi.fn();
    const original = process.kill;
    (process as any).kill = killFn;
    try {
      expect(defaultIsProcessGroupAlive(123, platform)).toBe(true);
    } finally {
      process.kill = original;
    }
    expect(killFn).toHaveBeenCalledWith(expected, 0);
  });
});

describe('killProcessGroup on win32 (injected platform + taskkill)', () => {
  const ok: TaskkillResult = { exitCode: 0, stdout: '', stderr: '' };
  const makeTaskkill = (r: TaskkillResult = ok) => vi.fn(async (_args: readonly string[]) => r);

  it('runs graceful then forced taskkill and never calls killFn', async () => {
    const taskkillFn = makeTaskkill();
    const killFn = vi.fn();
    const outcome = await killProcessGroup(42, {
      platform: 'win32',
      taskkillFn,
      killFn,
      isAliveFn: () => true,
      sleepFn: noopSleep,
      graceMs: 0,
    });
    expect(taskkillFn.mock.calls.map((c) => c[0])).toEqual([
      ['/T', '/PID', '42'],
      ['/T', '/F', '/PID', '42'],
    ]);
    expect(killFn).not.toHaveBeenCalled();
    expect(outcome).toEqual({ pgid: 42, terminated: false, forced: true });
  });

  it('stops after the graceful taskkill when the root exits', async () => {
    const taskkillFn = makeTaskkill();
    const outcome = await killProcessGroup(42, {
      platform: 'win32',
      taskkillFn,
      isAliveFn: () => false,
      sleepFn: noopSleep,
      graceMs: 100,
    });
    expect(taskkillFn).toHaveBeenCalledTimes(1);
    expect(taskkillFn).toHaveBeenCalledWith(['/T', '/PID', '42']);
    expect(outcome).toEqual({ pgid: 42, terminated: true, forced: false });
  });

  it.each([
    ['exit 128', { exitCode: 128, stdout: '', stderr: '' }],
    ['not found text', { exitCode: 1, stdout: 'ERROR: The process "42" not found.', stderr: '' }],
  ])('maps %s to dead', async (_name, result) => {
    const taskkillFn = makeTaskkill(result);
    const outcome = await killProcessGroup(42, { platform: 'win32', taskkillFn, isAliveFn: () => true });
    expect(outcome).toEqual({ pgid: 42, terminated: true, forced: false });
    expect(taskkillFn).toHaveBeenCalledTimes(1);
  });

  it('maps Access is denied to not-ours', async () => {
    const taskkillFn = makeTaskkill({ exitCode: 1, stdout: '', stderr: 'ERROR: Access is denied.' });
    const outcome = await killProcessGroup(42, { platform: 'win32', taskkillFn, isAliveFn: () => true });
    expect(outcome).toEqual({ pgid: 42, terminated: false, forced: false });
  });

  it('resolves when taskkillFn rejects', async () => {
    const taskkillFn = vi.fn(async () => {
      throw new Error('boom');
    });
    const outcome = await killProcessGroup(42, {
      platform: 'win32',
      taskkillFn,
      isAliveFn: () => false,
      sleepFn: noopSleep,
      graceMs: 0,
    });
    expect(outcome.terminated).toBe(true);
  });

  it('escalates to /F when graceful taskkill reports it can only terminate forcefully', async () => {
    const taskkillFn = makeTaskkill({ exitCode: 1, stdout: '', stderr: 'can only be terminated forcefully' });
    await killProcessGroup(42, {
      platform: 'win32',
      taskkillFn,
      isAliveFn: () => true,
      sleepFn: noopSleep,
      graceMs: 0,
    });
    expect(taskkillFn).toHaveBeenCalledTimes(2);
    expect(taskkillFn).toHaveBeenLastCalledWith(['/T', '/F', '/PID', '42']);
  });

  it.each(['darwin', 'linux'] as const)('uses the POSIX signal path on %s', async (platform) => {
    const killFn = vi.fn();
    const taskkillFn = makeTaskkill();
    await killProcessGroup(42, { platform, killFn, taskkillFn, isAliveFn: () => true, sleepFn: noopSleep, graceMs: 0 });
    expect(killFn.mock.calls).toEqual([
      [-42, 'SIGTERM'],
      [-42, 'SIGKILL'],
    ]);
    expect(taskkillFn).not.toHaveBeenCalled();
  });

  it('ProcessGroupTracker.killAll taskkills each live pid', async () => {
    const tracker = new ProcessGroupTracker();
    tracker.track(10);
    tracker.track(11);
    const taskkillFn = makeTaskkill();
    await tracker.killAll({
      platform: 'win32',
      taskkillFn,
      isAliveFn: () => true,
      sleepFn: noopSleep,
      graceMs: 0,
    });
    const pids = taskkillFn.mock.calls.filter((c) => !c[0].includes('/F')).map((c) => c[0][2]);
    expect(pids.sort()).toEqual(['10', '11']);
  });
});

describe('killProcessGroup (unit, injected fns)', () => {
  it('resolves terminated=false, forced=false when SIGTERM signal fails with ESRCH', async () => {
    const killFn = vi.fn(() => {
      const err: any = new Error('no such process');
      err.code = 'ESRCH';
      throw err;
    });
    const outcome = await killProcessGroup(42, { killFn, isAliveFn: () => true, sleepFn: noopSleep });
    expect(outcome).toEqual({ pgid: 42, terminated: true, forced: false });
    expect(killFn).toHaveBeenCalledTimes(1);
  });

  it('resolves terminated=false, forced=false when SIGTERM fails with EPERM (not ours)', async () => {
    const killFn = vi.fn(() => {
      const err: any = new Error('not permitted');
      err.code = 'EPERM';
      throw err;
    });
    const isAliveFn = vi.fn(() => true);
    const outcome = await killProcessGroup(42, { killFn, isAliveFn, sleepFn: noopSleep, graceMs: 50 });
    expect(outcome.terminated).toBe(false);
    expect(outcome.forced).toBe(false);
  });

  it('terminates on SIGTERM alone when the group dies within grace', async () => {
    let alive = true;
    const killFn = vi.fn((_pid: number, signal: NodeJS.Signals | 0) => {
      if (signal === 'SIGTERM') alive = false;
    });
    const outcome = await killProcessGroup(7, {
      killFn,
      isAliveFn: () => alive,
      sleepFn: noopSleep,
      graceMs: 1000,
    });
    expect(outcome).toEqual({ pgid: 7, terminated: true, forced: false });
    expect(killFn).toHaveBeenCalledTimes(1);
    expect(killFn).toHaveBeenCalledWith(-7, 'SIGTERM');
  });

  it('escalates to SIGKILL when still alive after grace', async () => {
    const signals: (NodeJS.Signals | 0)[] = [];
    let alive = true;
    const killFn = vi.fn((_pid: number, signal: NodeJS.Signals | 0) => {
      signals.push(signal);
      if (signal === 'SIGKILL') alive = false;
    });
    const outcome = await killProcessGroup(9, {
      killFn,
      isAliveFn: () => alive,
      sleepFn: noopSleep,
      graceMs: 10,
    });
    expect(outcome).toEqual({ pgid: 9, terminated: true, forced: true });
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('reports forced but not terminated when SIGKILL cannot clear the group', async () => {
    const killFn = vi.fn(() => undefined);
    const outcome = await killProcessGroup(11, {
      killFn,
      isAliveFn: () => true,
      sleepFn: noopSleep,
      graceMs: 5,
    });
    expect(outcome).toEqual({ pgid: 11, terminated: false, forced: true });
  });

  it('swallows ESRCH on the SIGKILL escalation', async () => {
    let killCount = 0;
    const killFn = vi.fn((_pid: number, signal: NodeJS.Signals | 0) => {
      if (signal === 'SIGKILL') {
        killCount++;
        const err: any = new Error('no such process');
        err.code = 'ESRCH';
        throw err;
      }
    });
    const outcome = await killProcessGroup(13, {
      killFn,
      isAliveFn: () => true,
      sleepFn: noopSleep,
      graceMs: 5,
    });
    expect(killCount).toBe(1);
    expect(outcome.forced).toBe(true);
  });
});

describe('ProcessGroupTracker', () => {
  it('tracks and untracks pgids', () => {
    const tracker = new ProcessGroupTracker();
    tracker.track(1);
    tracker.track(2);
    expect(tracker.pgids.sort()).toEqual([1, 2]);
    tracker.untrack(1);
    expect(tracker.pgids).toEqual([2]);
  });

  it('killAll skips already-dead groups, kills the rest, and clears itself', async () => {
    const tracker = new ProcessGroupTracker();
    tracker.track(1);
    tracker.track(2);
    const isAliveFn = vi.fn((pgid: number) => pgid === 2);
    const killFn = vi.fn(() => undefined);

    const outcomes = await tracker.killAll({ isAliveFn, killFn, sleepFn: noopSleep, graceMs: 5 });

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].pgid).toBe(2);
    expect(tracker.pgids).toEqual([]);
  });

  it('killAll is idempotent: a second call returns []', async () => {
    const tracker = new ProcessGroupTracker();
    tracker.track(5);
    await tracker.killAll({ isAliveFn: () => false, sleepFn: noopSleep });
    const second = await tracker.killAll({ isAliveFn: () => false, sleepFn: noopSleep });
    expect(second).toEqual([]);
  });
});

describe.skipIf(process.platform === 'win32')('killProcessGroup (real process integration)', () => {
  it('kills a detached child and its grandchild together', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pg-kill-'));
    const pidFile = join(dir, 'gc.pid');
    try {
      const child = spawn('sh', ['-c', `sleep 30 & echo $! > ${pidFile}; wait`], {
        detached: true,
        stdio: 'ignore',
      });
      expect(child.pid).toBeDefined();

      // Wait for the grandchild pid file to appear.
      let grandchildPid: number | undefined;
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        try {
          const raw = (await readFile(pidFile, 'utf-8')).trim();
          if (raw) {
            grandchildPid = Number(raw);
            break;
          }
        } catch {
          // not written yet
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(grandchildPid).toBeDefined();

      const outcome = await killProcessGroup(child.pid as number, { graceMs: 200 });
      expect(outcome.terminated).toBe(true);

      const isDead = (pid: number): boolean => {
        try {
          process.kill(pid, 0);
          return false;
        } catch (err: any) {
          return err?.code === 'ESRCH';
        }
      };

      const aliveDeadline = Date.now() + 2000;
      let childDead = isDead(child.pid as number);
      let grandchildDead = isDead(grandchildPid as number);
      while (Date.now() < aliveDeadline && !(childDead && grandchildDead)) {
        await new Promise((r) => setTimeout(r, 100));
        childDead = isDead(child.pid as number);
        grandchildDead = isDead(grandchildPid as number);
      }

      expect(childDead).toBe(true);
      expect(grandchildDead).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 10000);
});
