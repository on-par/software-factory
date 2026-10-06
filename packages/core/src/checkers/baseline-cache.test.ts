import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { CheckerOutput } from '../types/index.js';
import { BaselineCache, hashBaselineEnv } from './baseline-cache.js';

const tempDirs = new Set<string>();

afterEach(async () => {
  await Promise.all([...tempDirs].map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.clear();
});

async function cacheFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'baseline-cache-'));
  tempDirs.add(dir);
  return join(dir, 'state', 'baseline-cache.json');
}

const out = (checker: string, result: CheckerOutput['result'], details = ''): CheckerOutput => ({
  checker,
  result,
  details,
});

describe('hashBaselineEnv', () => {
  it('is stable across key order', () => {
    expect(hashBaselineEnv({ A: '1', B: '2' })).toBe(hashBaselineEnv({ B: '2', A: '1' }));
  });

  it('ignores per-lane and per-run keys', () => {
    const base = { FACTORY_HEADLESS: '1' };
    expect(
      hashBaselineEnv({
        ...base,
        PORT: '4001',
        FACTORY_APP_PORT: '4001',
        FACTORY_BASE_URL: 'http://127.0.0.1:4001',
        SharedCompilationId: 'factory-run1',
      }),
    ).toBe(hashBaselineEnv(base));
  });

  it('changes when a key is added, removed or changed', () => {
    const withKey = hashBaselineEnv({ FACTORY_HEADLESS: '1' });
    expect(withKey).not.toBe(hashBaselineEnv({}));
    expect(withKey).not.toBe(hashBaselineEnv({ FACTORY_HEADLESS: '0' }));
  });

  it('treats undefined like an empty env', () => {
    expect(hashBaselineEnv(undefined)).toBe(hashBaselineEnv({}));
    expect(hashBaselineEnv({})).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('BaselineCache', () => {
  it('misses on a missing file', async () => {
    const cache = new BaselineCache(await cacheFile());
    expect(await cache.get('sha', 'env', 'tests')).toBeUndefined();
  });

  it('round-trips and writes a versioned file', async () => {
    const file = await cacheFile();
    const cache = new BaselineCache(file, () => 0);
    await cache.set('sha', 'env', [out('tests', 'FAIL', 'boom'), out('lint', 'PASS')]);
    expect(await cache.get('sha', 'env', 'tests')).toEqual(out('tests', 'FAIL', 'boom'));
    expect(await cache.get('sha', 'env', 'lint')).toEqual(out('lint', 'PASS'));
    const parsed = JSON.parse(await readFile(file, 'utf-8'));
    expect(parsed.version).toBe(1);
    expect(parsed.entries['sha:env:tests'].recordedAt).toBe('1970-01-01T00:00:00.000Z');
  });

  it('misses on a different envHash or baseSha', async () => {
    const cache = new BaselineCache(await cacheFile());
    await cache.set('sha', 'env', [out('tests', 'FAIL')]);
    expect(await cache.get('sha', 'other', 'tests')).toBeUndefined();
    expect(await cache.get('other', 'env', 'tests')).toBeUndefined();
  });

  it('does not store SKIP outputs and does not create the file for an all-SKIP set', async () => {
    const file = await cacheFile();
    const cache = new BaselineCache(file);
    await cache.set('sha', 'env', [out('tests', 'SKIP')]);
    expect(existsSync(file)).toBe(false);
    await cache.set('sha', 'env', [out('tests', 'SKIP'), out('lint', 'PASS')]);
    expect(await cache.get('sha', 'env', 'tests')).toBeUndefined();
    expect(await cache.get('sha', 'env', 'lint')).toBeDefined();
  });

  it('ignores entries whose stored output does not match', async () => {
    const file = await cacheFile();
    const cache = new BaselineCache(file);
    await cache.set('sha', 'env', [out('tests', 'FAIL')]);
    const parsed = JSON.parse(await readFile(file, 'utf-8'));
    parsed.entries['sha:env:tests'].output.checker = 'lint';
    await writeFile(file, JSON.stringify(parsed));
    expect(await cache.get('sha', 'env', 'tests')).toBeUndefined();
    parsed.entries['sha:env:tests'].output = null;
    await writeFile(file, JSON.stringify(parsed));
    expect(await cache.get('sha', 'env', 'tests')).toBeUndefined();
  });

  it('treats malformed JSON as empty and repairs it on the next set', async () => {
    const file = await cacheFile();
    const cache = new BaselineCache(file);
    await cache.set('sha', 'env', [out('lint', 'PASS')]);
    await writeFile(file, '{not json');
    expect(await cache.get('sha', 'env', 'lint')).toBeUndefined();
    await cache.set('sha', 'env', [out('tests', 'FAIL')]);
    expect(await cache.get('sha', 'env', 'tests')).toBeDefined();
    await writeFile(file, JSON.stringify({ version: 1, entries: [] }));
    expect(await cache.get('sha', 'env', 'tests')).toBeUndefined();
  });
});
