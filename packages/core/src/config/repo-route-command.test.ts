import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ModelRegistry } from '../models/index.js';
import type { ModelsConfig } from './index.js';
import { loadRepoConfig, resolveEffectiveBuildRoute } from './repo.js';

const tempDirs = new Set<string>();

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all([...tempDirs].map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.clear();
});

const models: ModelsConfig = {
  version: 1,
  models: {},
  tiers: {},
  failover: {
    triggers: ['rate_limit', 'usage_cap', 'timeout', 'error', 'empty_response'],
    maxRetries: 2,
    cooldownMs: 0,
    escalateAfterTierExhausted: true,
  },
  routingRules: {},
};

async function writeRepoConfig(content: unknown): Promise<string> {
  const repoRoot = await mkdtemp(join(tmpdir(), 'repo-config-test-'));
  tempDirs.add(repoRoot);
  await mkdir(join(repoRoot, '.factory'), { recursive: true });
  await writeFile(join(repoRoot, '.factory', 'config.json'), JSON.stringify(content));
  return repoRoot;
}

describe('repo route command (#2874)', () => {
  it.each([1, 2])(
    'accepts route command from a v%i .factory/config.json and resolves it as the repo route (#2874)',
    async (version) => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const repo = loadRepoConfig(await writeRepoConfig({ version, route: 'command' }));
      expect(repo?.route).toBe('command');
      expect(resolveEffectiveBuildRoute(new ModelRegistry(models), repo, { sources: {} })).toEqual({
        route: 'command',
        source: 'repo',
      });
    },
  );

  it('still rejects an unknown route', async () => {
    const repoRoot = await writeRepoConfig({ version: 2, route: 'foo' });
    expect(() => loadRepoConfig(repoRoot)).toThrow();
  });
});
