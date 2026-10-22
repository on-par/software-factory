import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';

import { loadFactoryConfig, loadFactoryConfigForRepo } from './index.js';

const tempDirs = createTempDirs();

describe('sandbox.writablePaths config (#3454)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await tempDirs.make('factory-sandbox-schema-');
  });

  afterEach(async () => {
    await tempDirs.cleanup();
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
