import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { createTempDirs } from '@on-par/factory-core/testing';

import { resolveHermeticGit } from './base-health.js';
import { loadRepoConfig } from './repo.js';

const tempDirs = createTempDirs();

afterEach(async () => {
  await tempDirs.cleanup();
});

async function repoWith(config: unknown): Promise<string> {
  const dir = await tempDirs.make('hermetic-git-config-');
  await mkdir(join(dir, '.factory'), { recursive: true });
  await writeFile(join(dir, '.factory', 'config.json'), JSON.stringify(config));
  return dir;
}

describe('check.hermeticGit (#3272)', () => {
  it('is on for null, a missing check section and an unset key', () => {
    expect(resolveHermeticGit(null)).toBe(true);
    expect(resolveHermeticGit({})).toBe(true);
    expect(resolveHermeticGit({ check: {} })).toBe(true);
    expect(resolveHermeticGit({ check: { hermeticGit: true } })).toBe(true);
  });

  it('is off only when the repo sets false', async () => {
    const loaded = loadRepoConfig(await repoWith({ version: 2, check: { hermeticGit: false } }));
    expect(resolveHermeticGit(loaded)).toBe(false);
  });

  it('rejects a non-boolean value and an unknown key under check', async () => {
    const bad = await repoWith({ version: 2, check: { hermeticGit: 'no' } });
    expect(() => loadRepoConfig(bad)).toThrow(/hermeticGit/);
    const unknown = await repoWith({ version: 2, check: { hermetic: true } });
    expect(() => loadRepoConfig(unknown)).toThrow(/check/);
  });
});
