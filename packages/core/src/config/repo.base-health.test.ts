import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadRepoConfig, RepoFactoryConfigV2Schema } from './repo.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'repo-base-health-'));
  tempDirs.push(dir);
  return dir;
}

describe('repo baseHealth config', () => {
  it('keeps omitted, empty and valid settings distinct', () => {
    expect(RepoFactoryConfigV2Schema.parse({ version: 2 }).baseHealth).toBeUndefined();
    expect(RepoFactoryConfigV2Schema.parse({ version: 2, baseHealth: {} }).baseHealth).toEqual({});
    expect(RepoFactoryConfigV2Schema.parse({ version: 2, baseHealth: { checks: [] } }).baseHealth).toEqual({
      checks: [],
    });
    expect(
      RepoFactoryConfigV2Schema.parse({ version: 2, baseHealth: { checks: ['contract', 'ios'] } }).baseHealth,
    ).toEqual({ checks: ['contract', 'ios'] });
  });

  it('rejects malformed lists and unknown nested keys', () => {
    expect(RepoFactoryConfigV2Schema.safeParse({ version: 2, baseHealth: { checks: ['ok', 1] } }).success).toBe(false);
    expect(RepoFactoryConfigV2Schema.safeParse({ version: 2, baseHealth: { unknown: true } }).success).toBe(false);
    expect(RepoFactoryConfigV2Schema.safeParse({ version: 2, baseHealth: { checks: 'contract' } }).success).toBe(false);
  });

  it('loads baseHealth from the external repo config state root', async () => {
    const repoRoot = await tempDir();
    const stateRoot = await tempDir();
    await mkdir(stateRoot, { recursive: true });
    await writeFile(
      join(stateRoot, 'config.json'),
      JSON.stringify({ version: 2, baseHealth: { checks: ['contract'] } }),
    );
    expect(loadRepoConfig(repoRoot, stateRoot)?.baseHealth).toEqual({ checks: ['contract'] });
  });
});
