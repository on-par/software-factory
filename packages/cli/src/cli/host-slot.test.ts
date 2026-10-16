import { mkdtemp, readdir, rm } from 'node:fs/promises';
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
});
