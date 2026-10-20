import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveBaseHealthChecks } from './base-health.js';
import { loadRepoConfig } from './repo.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function repoWith(config: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'base-health-config-'));
  tempDirs.push(dir);
  await mkdir(join(dir, '.factory'), { recursive: true });
  await writeFile(join(dir, '.factory', 'config.json'), JSON.stringify(config));
  return dir;
}

describe('baseHealth.checks (#3290)', () => {
  it('round-trips through loadRepoConfig', async () => {
    const loaded = loadRepoConfig(await repoWith({ version: 2, baseHealth: { checks: ['contract', 'ios'] } }));
    expect(loaded).toEqual({ version: 2, baseHealth: { checks: ['contract', 'ios'] } });
    expect(resolveBaseHealthChecks(loaded)).toEqual(['contract', 'ios']);
  });

  it('rejects an unknown key under baseHealth', async () => {
    const repoRoot = await repoWith({ version: 2, baseHealth: { check: ['x'] } });
    expect(() => loadRepoConfig(repoRoot)).toThrow(/baseHealth/);
  });

  it('resolves to undefined for null, a missing key or an empty list', () => {
    expect(resolveBaseHealthChecks(null)).toBeUndefined();
    expect(resolveBaseHealthChecks({})).toBeUndefined();
    expect(resolveBaseHealthChecks({ baseHealth: { checks: [] } })).toBeUndefined();
  });

  it('trims and dedupes', () => {
    expect(resolveBaseHealthChecks({ baseHealth: { checks: [' a ', 'a', 'b'] } })).toEqual(['a', 'b']);
  });
});
