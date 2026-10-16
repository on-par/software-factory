// packages/cli/src/cli/queue-startup.test.ts — the startup stale lane-claim sweep never throws (#3065)

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { getFactoryPaths } from '@on-par/factory-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { sweepLaneClaims } from './queue-startup.js';

let dir: string;
let paths: ReturnType<typeof getFactoryPaths>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'factory-queue-startup-'));
  paths = { events: join(dir, 'events.jsonl'), laneFiles: join(dir, 'lane-files') } as ReturnType<
    typeof getFactoryPaths
  >;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('sweepLaneClaims', () => {
  it('skips the sweep and logs nothing when there is no GitHub token', async () => {
    await sweepLaneClaims(paths, 'o/r', () => undefined);
    await expect(readFile(paths.events, 'utf8')).rejects.toThrow();
  });

  it('logs a warn instead of throwing when the sweep fails', async () => {
    await expect(
      sweepLaneClaims(paths, 'o/r', () => {
        throw new Error('token store unreadable');
      }),
    ).resolves.toBeUndefined();
    expect(await readFile(paths.events, 'utf8')).toContain('lane claim sweep failed: token store unreadable');
  });
});
