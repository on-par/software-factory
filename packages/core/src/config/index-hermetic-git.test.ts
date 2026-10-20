import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadFactoryConfigForRepo } from './index.js';
import { loadRepoConfig } from './repo.js';

describe('runtime CHECK Git config', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'factory-check-config-'));
    await mkdir(join(dir, '.factory'));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  });

  it('loads check.hermeticGit=false from repo JSON without losing it to either config namespace', async () => {
    const path = join(dir, '.factory', 'config.json');
    await writeFile(path, JSON.stringify({ version: 2, check: { hermeticGit: false } }));
    expect(loadRepoConfig(dir)).not.toBeNull();
    expect(loadFactoryConfigForRepo(path).check.hermeticGit).toBe(false);
    await writeFile(path, JSON.stringify({ version: 2, check: {} }));
    expect(loadFactoryConfigForRepo(path).check.hermeticGit).toBe(true);
    await writeFile(path, JSON.stringify({ version: 2, check: { hermeticGit: true } }));
    expect(loadFactoryConfigForRepo(path).check.hermeticGit).toBe(true);
    for (const value of [null, 'false', 0, [], { hermeticGit: 'false' }, { unknown: true }]) {
      await writeFile(path, JSON.stringify({ version: 2, check: value }));
      expect(() => loadFactoryConfigForRepo(path)).toThrow();
    }
  });

  it('accepts the CHECK setting from YAML and the resolved run snapshot', async () => {
    const path = join(dir, '.factory', 'config.yaml');
    await writeFile(path, 'version: 2\ncheck:\n  hermeticGit: false\n');
    expect(loadFactoryConfigForRepo(path).check.hermeticGit).toBe(false);
    vi.stubEnv('FACTORY_RUN_CONFIG_JSON', JSON.stringify({ version: 2, check: { hermeticGit: false } }));
    expect(loadFactoryConfigForRepo(path).check.hermeticGit).toBe(false);
    expect(loadRepoConfig(dir)).not.toBeNull();
  });
});
