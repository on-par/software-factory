import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadFactoryConfig } from '@on-par/factory-core';
import { createRunSlotGate } from '@on-par/factory-core/internal';

import { hostBuildSlotPort } from './host-slot.js';

let dir: string;

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
    const log = vi.fn();
    const port = hostBuildSlotPort(loadFactoryConfig(), 'o/r', 7, log);
    await expect(port('build', async () => 'ok')).resolves.toBe('ok');
    expect(log).toHaveBeenCalledWith(
      'environment_lease',
      expect.stringContaining(`reclaimed host build slot 0 from o/dead#12 (pid ${deadPid}`),
    );
  });
});

describe('hostBuildSlotPort with a run gate (#3049)', () => {
  it('serialises lanes on the run cap and logs the run wait line', async () => {
    const log = vi.fn();
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
    expect(log).toHaveBeenCalledWith('environment_lease', 'waiting for run build slot (1/1 in use)');
  });
});

describe('hostBuildSlotPort with a disk guard (#2284)', () => {
  const hold = { kind: 'hold' as const, freeGb: 2, thresholdGb: 10, path: '/w', retryMs: 300_000 };

  it('waits at the check boundary while disk is low and runs fn only after recovery', async () => {
    const decisions = [hold, hold, { kind: 'claim' as const }];
    const guard: any = { check: () => decisions.shift() };
    const order: string[] = [];
    const log = vi.fn((kind: string) => order.push(`log:${kind}`));
    const sleep = vi.fn(async () => {
      order.push('sleep');
    });
    const port = hostBuildSlotPort(loadFactoryConfig(), 'o/r', 7, log as any, undefined, { guard, sleep });
    await port('check', async () => {
      order.push('fn');
      expect((await readdir(dir)).filter((f) => f.startsWith('slot-'))).toEqual(['slot-0.json']);
    });
    expect(order).toEqual(['log:disk_low', 'sleep', 'log:warn', 'sleep', 'fn']);
    expect(sleep).toHaveBeenCalledWith(300_000);
    expect(log).toHaveBeenCalledWith('disk_low', expect.stringContaining('#7 check waiting:'));
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
