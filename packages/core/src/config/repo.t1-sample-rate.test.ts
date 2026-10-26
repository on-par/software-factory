import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadRepoConfig, resolveT1SampleRate } from './repo.js';

const tempDirs = new Set<string>();
afterEach(async () => {
  await Promise.all([...tempDirs].map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.clear();
});

async function repoWith(classifier: unknown): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'repo-t1-rate-test-'));
  tempDirs.add(root);
  await mkdir(join(root, '.factory'), { recursive: true });
  await writeFile(join(root, '.factory', 'config.json'), JSON.stringify({ version: 2, classifier }));
  return root;
}

describe('classifier.t1SampleRate (#1958)', () => {
  it('defaults to 0.25 without a config or the key', async () => {
    expect(resolveT1SampleRate(null)).toBe(0.25);
    expect(resolveT1SampleRate(loadRepoConfig(await repoWith({ trustTier: 'T1' })))).toBe(0.25);
  });

  it.each([0, 0.25, 1])('loads t1SampleRate %j', async (rate) => {
    expect(resolveT1SampleRate(loadRepoConfig(await repoWith({ t1SampleRate: rate })))).toBe(rate);
  });

  it.each([-0.1, 1.5, '0.2'])('rejects t1SampleRate %j naming the key', async (rate) => {
    const root = await repoWith({ t1SampleRate: rate });
    expect(() => loadRepoConfig(root)).toThrow(/classifier\.t1SampleRate/);
  });
});
