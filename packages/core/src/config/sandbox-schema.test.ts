import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadFactoryConfig, loadFactoryConfigForRepo } from './index.js';

describe('sandbox.writablePaths config (#3454)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'factory-sandbox-schema-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('loadFactoryConfigForRepo rejects an invalid sandbox.writablePaths entry', async () => {
    const path = join(dir, 'config.json');
    await writeFile(path, JSON.stringify({ sandbox: { writablePaths: ['relative/dir'] } }));
    expect(() => loadFactoryConfigForRepo(path)).toThrow(/sandbox\.writablePaths.*relative\/dir/);
  });

  it('keeps a valid sandbox.writablePaths entry and defaults to []', async () => {
    expect(loadFactoryConfig().sandbox.writablePaths).toEqual([]);
    const path = join(dir, 'config.json');
    await writeFile(path, JSON.stringify({ sandbox: { writablePaths: ['~/.nuget'] } }));
    expect(loadFactoryConfigForRepo(path).sandbox.writablePaths).toEqual(['~/.nuget']);
  });
});
