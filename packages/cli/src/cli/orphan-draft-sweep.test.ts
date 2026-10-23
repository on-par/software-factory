// packages/cli/src/cli/orphan-draft-sweep.test.ts — the startup orphan draft sweep never throws (#3552)

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { getFactoryPaths } from '@on-par/factory-core';
import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runOrphanDraftSweep } from './orphan-draft-sweep.js';

const tmp = createTempDirs();
let dir: string;
let paths: ReturnType<typeof getFactoryPaths>;

beforeEach(async () => {
  dir = await tmp.make('factory-orphan-draft-sweep-');
  paths = { events: join(dir, 'events.jsonl'), orphanDraftSweep: join(dir, 'sweep.json') } as ReturnType<
    typeof getFactoryPaths
  >;
});

afterEach(async () => {
  await tmp.cleanup();
});

describe('runOrphanDraftSweep', () => {
  it('is a no-op when there is no GitHub token', async () => {
    await runOrphanDraftSweep(paths, 'o/r', () => undefined);
    await expect(readFile(paths.events, 'utf8')).rejects.toThrow();
    await expect(readFile(paths.orphanDraftSweep, 'utf8')).rejects.toThrow();
  });

  it('logs a warn instead of throwing when the sweep fails', async () => {
    await expect(
      runOrphanDraftSweep(paths, 'o/r', () => {
        throw new Error('token store unreadable');
      }),
    ).resolves.toBeUndefined();
    expect(await readFile(paths.events, 'utf8')).toContain('orphan draft sweep failed: token store unreadable');
  });
});
