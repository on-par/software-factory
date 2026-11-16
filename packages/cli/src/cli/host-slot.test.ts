import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadFactoryConfig, type EventKind } from '@on-par/factory-core';
import { createDiskGuard, createRunSlotGate, resolveHostMaxBuilds } from '@on-par/factory-core/internal';

import { hostBuildSlotPort, shipHostBuildSlot } from './host-slot.js';

let dir: string;

const recorder = () => {
  const events: Array<[string, string]> = [];
  const sleeps: number[] = [];
  return {
    events,
    sleeps,
    log: (kind: EventKind, message: string) => void events.push([kind, message]),
    sleep: async (ms: number) => void sleeps.push(ms),
    saw: (kind: string, text: string) => events.some(([k, m]) => k === kind && m.includes(text)),
  };
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'factory-host-slot-port-'));
  vi.stubEnv('FACTORY_HOST_SLOTS_DIR', dir);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

describe('hostBuildSlotPort (#3043)', () => {
  it('runs fn inside a slot and frees it afterwards, even when fn throws', async () => {
    const port = hostBuildSlotPort(loadFactoryConfig(), 'o/r', 7, vi.fn());
    await expect(port('build', async () => (await readdir(dir)).filter((f) => f.startsWith('slot-')))).resolves.toEqual(
      ['slot-0.json'],
    );
    await expect(port('check', async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect((await readdir(dir)).filter((f) => f.startsWith('slot-'))).toEqual([]);
  });

  it("logs an environment_lease event naming the reclaimed slot and the dead holder's repo, issue and pid", async () => {
    const deadPid = spawnSync(process.execPath, ['-e', '']).pid as number;
    for (const [slot, token] of [
      [0, 'a'],
      [1, 'b'],
    ] as const) {
      await writeFile(
        join(dir, `slot-${slot}.json`),
        JSON.stringify({ pid: deadPid, repo: 'o/dead', issue: 12, phase: 'build', token, acquiredAt: '' }),
      );
    }
    const { events, log } = recorder();
    const port = hostBuildSlotPort(loadFactoryConfig(), 'o/r', 7, log);
    await expect(port('build', async () => 'ok')).resolves.toBe('ok');
    expect(events).toContainEqual([
      'environment_lease',
      expect.stringContaining(`reclaimed host build slot 0 from o/dead#12 (pid ${deadPid}`),
    ]);
  });
});

describe('hostBuildSlotPort with a run gate (#3049)', () => {
  it('serialises lanes on the run cap and logs the run wait line', async () => {
    const { events, log } = recorder();
    const port = hostBuildSlotPort(loadFactoryConfig(), 'o/r', 7, log, createRunSlotGate(1));
    let active = 0;
    let maxActive = 0;
    const fn = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 30));
      active -= 1;
    };
    await Promise.all([port('build', fn), port('check', fn)]);
    expect(maxActive).toBe(1);
    expect(events).toContainEqual(['environment_lease', 'waiting for run build slot (1/1 in use)']);
  });
});

describe('hostBuildSlotPort with a disk guard (#2284)', () => {
  const hold = { kind: 'hold' as const, freeGb: 2, thresholdGb: 10, path: '/w', retryMs: 300_000 };

  it('uses the default timer while waiting for disk recovery', async () => {
    vi.useFakeTimers();
    try {
      const decisions = [{ ...hold, retryMs: 25 }];
      let checks = 0;
      const check = () => {
        checks += 1;
        return decisions.shift() ?? { kind: 'claim' as const };
      };
      const { events, log } = recorder();
      let ran = false;
      const fn = async () => {
        ran = true;
        return 'built';
      };
      const config = loadFactoryConfig();
      const guard = createDiskGuard(config, { repoRoot: dir, ghRepo: 'o/r', stateRoot: dir });
      const port = hostBuildSlotPort(config, 'o/r', 7, log, undefined, { guard: { ...guard, check } });
      const result = port('build', fn);
      await vi.advanceTimersByTimeAsync(24);
      expect(ran).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(result).resolves.toBe('built');
      expect(checks).toBe(2);
      expect(events).toContainEqual(['disk_low', expect.stringContaining('#7 build waiting:')]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits at the check boundary while disk is low and runs fn only after recovery', async () => {
    const decisions = [hold, hold, { kind: 'claim' as const }];
    const guard: any = { check: () => decisions.shift() };
    const order: string[] = [];
    const rec = recorder();
    const { events, sleeps } = rec;
    const log = (kind: EventKind, message: string) => (order.push(`log:${kind}`), rec.log(kind, message));
    const sleep = async (ms: number) => (order.push('sleep'), rec.sleep(ms));
    const port = hostBuildSlotPort(loadFactoryConfig(), 'o/r', 7, log, undefined, { guard, sleep });
    await port('check', async () => {
      order.push('fn');
      expect((await readdir(dir)).filter((f) => f.startsWith('slot-'))).toEqual(['slot-0.json']);
    });
    expect(order).toEqual(['log:disk_low', 'sleep', 'log:warn', 'sleep', 'fn']);
    expect(sleeps).toEqual([300_000, 300_000]);
    expect(events).toContainEqual(['disk_low', expect.stringContaining('#7 check waiting:')]);
  });

  it('reclaims retained trees on a disk hold and proceeds without changing maxBuilds', async () => {
    const config = loadFactoryConfig();
    const maxBefore = resolveHostMaxBuilds(config);
    let reclaimed = false;
    const guard: any = { check: () => (reclaimed ? { kind: 'claim' } : hold) };
    let reclaims = 0;
    const reclaim = async () => {
      reclaims += 1;
      reclaimed = true;
    };
    const { events, sleeps, sleep, log } = recorder();
    const fn = async () => 'built';
    const port = hostBuildSlotPort(config, 'o/r', 7, log, undefined, { guard, reclaim, sleep });
    await expect(port('build', fn)).resolves.toBe('built');
    expect(reclaims).toBe(1);
    expect(sleeps).toEqual([]);
    expect(events.filter(([k]) => k === 'disk_low')).toEqual([]);
    expect(resolveHostMaxBuilds(config)).toBe(maxBefore);
  });

  it('falls back to waiting when reclaim does not free space', async () => {
    const decisions = [hold, hold, hold, { kind: 'claim' as const }, { kind: 'claim' as const }];
    const guard: any = { check: () => decisions.shift() };
    let reclaims = 0;
    const reclaim = async () => {
      reclaims += 1;
      throw new Error('busy');
    };
    const { events, sleeps, sleep, log } = recorder();
    const port = hostBuildSlotPort(loadFactoryConfig(), 'o/r', 7, log, undefined, { guard, reclaim, sleep });
    await port('check', async () => 'ok');
    expect(reclaims).toBe(2);
    expect(sleeps).toHaveLength(1);
    expect(events).toContainEqual(['disk_low', expect.stringContaining('#7 check waiting:')]);
  });

  it('treats a throwing guard as claim and takes no slot while held', async () => {
    const guard: any = {
      check: () => {
        throw new Error('boom');
      },
    };
    const port = hostBuildSlotPort(loadFactoryConfig(), 'o/r', 7, vi.fn(), undefined, { guard });
    await expect(port('build', async () => 'ok')).resolves.toBe('ok');
  });
});

describe('shipHostBuildSlot reclaim wiring (#3970)', () => {
  it('reclaims retained worktrees before waiting on a low disk, and only with lock paths', async () => {
    vi.stubEnv('FACTORY_MIN_FREE_GB', '1000000000');
    const config = loadFactoryConfig();
    const { log, saw } = recorder();
    const where = {
      repoRoot: dir,
      ghRepo: 'o/r',
      paths: { root: dir, mergeLock: join(dir, 'm.lock'), gitLock: join(dir, 'g.lock') },
    };
    void shipHostBuildSlot(config, 7, log, where)('build', async () => 'built');
    // The tmp dir is not a git repo, so the reclaim logs a warn and skips; the wait still starts.
    await vi.waitFor(() => expect(saw('disk_low', '#7 build waiting:')).toBe(true));
    expect(saw('warn', 'retention reclaim failed')).toBe(true);

    const { events: bareEvents, log: bare, saw: bareSaw } = recorder();
    void shipHostBuildSlot(config, 8, bare, { ...where, paths: { root: dir } })('build', async () => 'built');
    await vi.waitFor(() => expect(bareSaw('disk_low', '#8 build waiting:')).toBe(true));
    expect(bareEvents.filter(([k]) => k === 'warn')).toEqual([]);
  });
});
