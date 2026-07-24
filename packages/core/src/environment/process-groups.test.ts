import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { defaultIsProcessGroupAlive, killProcessGroup, ProcessGroupTracker } from './process-groups.js';

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
