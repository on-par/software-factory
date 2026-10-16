import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadFactoryConfig } from '@on-par/factory-core';

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
