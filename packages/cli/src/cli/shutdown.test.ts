import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { defaultIsProcessGroupAlive } from '@on-par/factory-core';
import { createTempDirs } from '@on-par/factory-core/testing';
import {
  killTrackedProcessGroups,
  readStopMarker,
  registerProcessGroup,
  trackedProcessGroups,
} from '@on-par/factory-core/internal';

import { installShutdown, withShutdown, SHUTDOWN_FLUSH_GUARD_MS, type ShutdownSignals } from './shutdown.js';

const originalExitCode = process.exitCode;
const cleanups: Array<() => void> = [];
const tempDirs = createTempDirs();
afterEach(async () => {
  await tempDirs.cleanup();
  process.exitCode = originalExitCode;
  for (const c of cleanups.splice(0)) c();
});

function fakeSignals(): ShutdownSignals & EventEmitter {
  return new EventEmitter();
}

const tick = () => new Promise((r) => setImmediate(r));

describe('installShutdown export flush', () => {
  function setup(flushExports: () => Promise<never[] | Array<Record<string, unknown>>>) {
    const signals = fakeSignals();
    const order: string[] = [];
    const lines: string[] = [];
    const exit = vi.fn((code: number) => {
      order.push(`exit ${code}`);
    });
    installShutdown(new AbortController(), {
      stopFile: () => '/unused',
      writeStop: () => {},
      signals,
      exit,
      log: (l) => lines.push(l),
      killTracked: async () => {
        order.push('kill');
      },
      flushExports: (async (sig: NodeJS.Signals) => {
        order.push(`flush ${sig}`);
        return flushExports();
      }) as never,
    });
    return { signals, order, lines, exit };
  }

  it.each(['SIGINT', 'SIGTERM'] as const)('%s awaits flushExports before exit 130', async (sig) => {
    const { signals, order, exit } = setup(async () => {
      await tick();
      order.push('flushed');
      return [];
    });
    signals.emit(sig, sig);
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(130));
    expect(order).toEqual(['kill', `flush ${sig}`, 'flushed', 'exit 130']);
  });

  it('a hung flush is abandoned after the guard and still exits 130', async () => {
    vi.useFakeTimers();
    try {
      const { signals, lines, exit } = setup(() => new Promise(() => {}));
      signals.emit('SIGINT', 'SIGINT');
      await vi.advanceTimersByTimeAsync(SHUTDOWN_FLUSH_GUARD_MS + 1);
      expect(exit).toHaveBeenCalledWith(130);
      expect(lines.join('\n')).toContain(`flush timed out after ${SHUTDOWN_FLUSH_GUARD_MS} ms — records may be lost`);
    } finally {
      vi.useRealTimers();
    }
  });

  it('incomplete flush reports are logged', async () => {
    const { signals, lines, exit } = setup(async () => [
      { runId: 'run-9', sessionId: 'abcd', complete: false, sent: 1, dropped: 2, failed: 3, retries: 0 },
      { runId: 'run-ok', sessionId: 'efgh', complete: true, sent: 4, dropped: 0, failed: 0, retries: 0 },
    ]);
    signals.emit('SIGTERM', 'SIGTERM');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(130));
    expect(lines).toContain('factory: command output export incomplete for run run-9: 2 dropped, 3 failed');
    expect(lines.join('\n')).not.toContain('run-ok');
  });

  it('a rejecting flush never blocks exit', async () => {
    const { signals, exit } = setup(() => Promise.reject(new Error('boom')));
    signals.emit('SIGINT', 'SIGINT');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(130));
  });

  it('with no active export session the default flush is a no-op', async () => {
    const signals = fakeSignals();
    const lines: string[] = [];
    const exit = vi.fn();
    installShutdown(new AbortController(), {
      stopFile: () => '/unused',
      writeStop: () => {},
      signals,
      exit,
      log: (l) => lines.push(l),
      killTracked: async () => {},
    });
    signals.emit('SIGINT', 'SIGINT');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(130));
    expect(signals.listenerCount('SIGINT')).toBe(1);
    expect(lines.filter((l) => l.includes('command output export'))).toEqual([]);
  });
});

describe('installShutdown', () => {
  it('first SIGINT SIGTERMs every tracked process group, SIGKILLs survivors after the grace and exits 130', async () => {
    const calls: string[] = [];
    const alive = new Set([910001, 910002]);
    cleanups.push(registerProcessGroup(910001), registerProcessGroup(910002));
    const killFn = (pid: number, signal: NodeJS.Signals | 0) => {
      calls.push(`${pid} ${String(signal)}`);
      if (signal === 'SIGKILL') alive.delete(-pid);
    };
    const signals = fakeSignals();
    const exit = vi.fn((code: number) => {
      calls.push(`exit ${code}`);
    });
    installShutdown(new AbortController(), {
      stopFile: () => '/unused',
      writeStop: () => {},
      signals,
      exit,
      log: () => {},
      graceMs: 50,
      killTracked: ({ graceMs }) =>
        killTrackedProcessGroups({
          graceMs,
          killFn,
          isAliveFn: (pgid) => alive.has(pgid),
          sleepFn: async () => {
            calls.push('grace');
            await tick();
          },
        }),
    });
    signals.emit('SIGINT', 'SIGINT');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(130));
    const grace = calls.indexOf('grace');
    expect(grace).toBeGreaterThan(0);
    expect(calls.filter((c) => c.endsWith('SIGTERM')).sort()).toEqual(['-910001 SIGTERM', '-910002 SIGTERM']);
    expect(calls.lastIndexOf('-910001 SIGTERM')).toBeLessThan(grace + 1);
    expect(calls.indexOf('-910001 SIGKILL')).toBeGreaterThan(grace);
    expect(calls.indexOf('-910002 SIGKILL')).toBeGreaterThan(grace);
    expect(calls.at(-1)).toBe('exit 130');
    expect(process.exitCode).toBe(130);
    expect(trackedProcessGroups()).not.toContain(910001);
  });

  describe('STOP file', () => {
    it('SIGTERM writes the STOP file and aborts the controller', async () => {
      const dir = tempDirs.makeSync('shutdown-');
      const path = join(dir, 'state', 'STOP');
      const controller = new AbortController();
      const signals = fakeSignals();
      const exit = vi.fn();
      installShutdown(controller, {
        stopFile: () => path,
        signals,
        exit,
        log: () => {},
        killTracked: async () => [],
      });
      signals.emit('SIGTERM', 'SIGTERM');
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(130));
      expect(existsSync(path)).toBe(true);
      expect(readStopMarker(path)?.source).toBe('manual');
      expect(controller.signal.aborted).toBe(true);
    });

    it('leaves an existing STOP file as is', async () => {
      const dir = tempDirs.makeSync('shutdown-');
      const path = join(dir, 'STOP');
      writeFileSync(path, 'existing');
      const signals = fakeSignals();
      const exit = vi.fn();
      installShutdown(new AbortController(), {
        stopFile: () => path,
        signals,
        exit,
        log: () => {},
        killTracked: async () => [],
      });
      signals.emit('SIGINT', 'SIGINT');
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(130));
      expect(readFileSync(path, 'utf8')).toBe('existing');
    });

    it('still sweeps and exits when the STOP path cannot be resolved', async () => {
      const signals = fakeSignals();
      const exit = vi.fn();
      const killTracked = vi.fn(async () => []);
      installShutdown(new AbortController(), {
        stopFile: () => {
          throw new Error('not a repo');
        },
        signals,
        exit,
        log: () => {},
        killTracked,
      });
      signals.emit('SIGINT', 'SIGINT');
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(130));
      expect(killTracked).toHaveBeenCalledWith({ graceMs: 3000 });
    });
  });

  it('a second signal during shutdown exits 130 immediately', async () => {
    const signals = fakeSignals();
    const exit = vi.fn();
    const killTracked = vi.fn(() => new Promise<never>(() => {}));
    installShutdown(new AbortController(), {
      stopFile: () => '/unused',
      writeStop: () => {},
      signals,
      exit,
      log: () => {},
      killTracked,
    });
    signals.emit('SIGINT', 'SIGINT');
    await vi.waitFor(() => expect(killTracked).toHaveBeenCalled());
    signals.emit('SIGINT', 'SIGINT');
    await tick();
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(130);
  });

  it('dispose removes the SIGINT and SIGTERM listeners', () => {
    const signals = fakeSignals();
    const handle = installShutdown(new AbortController(), { stopFile: () => '/unused', signals });
    expect(signals.listenerCount('SIGINT')).toBe(1);
    expect(signals.listenerCount('SIGTERM')).toBe(1);
    handle.dispose();
    expect(signals.listenerCount('SIGINT')).toBe(0);
    expect(signals.listenerCount('SIGTERM')).toBe(0);
  });

  it('withShutdown disposes after the wrapped command settles', async () => {
    const signals = fakeSignals();
    const wrapped = withShutdown(
      async (n: number) => {
        expect(signals.listenerCount('SIGINT')).toBe(1);
        return n * 2;
      },
      { signals, stopFile: () => '/unused' },
    );
    await expect(wrapped(21)).resolves.toBe(42);
    expect(signals.listenerCount('SIGINT')).toBe(0);
    const failing = withShutdown(async () => Promise.reject(new Error('boom')), { signals });
    await expect(failing()).rejects.toThrow('boom');
    expect(signals.listenerCount('SIGTERM')).toBe(0);
  });

  describe.skipIf(process.platform === 'win32')('real process group', () => {
    it('kills a real detached child that traps SIGTERM', async () => {
      const child = spawn('sh', ['-c', "trap '' TERM; sleep 30"], { detached: true, stdio: 'ignore' });
      const pid = child.pid as number;
      cleanups.push(() => {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          // already gone
        }
      });
      cleanups.push(registerProcessGroup(pid));
      await new Promise((r) => setTimeout(r, 300)); // let sh install its trap
      const signals = fakeSignals();
      let outcomes: Array<{ forced?: boolean }> = [];
      const exit = vi.fn();
      installShutdown(new AbortController(), {
        stopFile: () => '/unused',
        writeStop: () => {},
        signals,
        exit,
        log: () => {},
        graceMs: 200,
        killTracked: async (o) => {
          outcomes = await killTrackedProcessGroups(o);
          return outcomes;
        },
      });
      signals.emit('SIGINT', 'SIGINT');
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(130), { timeout: 5000 });
      await vi.waitFor(() => expect(defaultIsProcessGroupAlive(pid)).toBe(false), { timeout: 2000 });
      expect(outcomes.some((o) => o.forced)).toBe(true);
    }, 10000);
  });
});
