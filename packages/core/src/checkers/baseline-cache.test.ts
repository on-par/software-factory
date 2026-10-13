import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { CheckerOutput, Constitution } from '../types/index.js';
import { BaselineCache, hashBaselineCheckerConfig, hashBaselineEnv } from './baseline-cache.js';
import { schemaErrorCheckerOutput, unfilledPlaceholderCheckerOutput, unknownCheckerOutput } from './index.js';

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

const constitution = (extra: Partial<Constitution> = {}): Constitution => ({
  product: 'p',
  version: 1,
  checkers: ['tests'],
  body: '',
  path: 'c.md',
  source: 'repo',
  ...extra,
});

describe('hashBaselineCheckerConfig', () => {
  it('is stable for equal configs and ignores body and path', () => {
    expect(hashBaselineCheckerConfig(constitution())).toBe(
      hashBaselineCheckerConfig(constitution({ body: 'other', path: 'x.md' })),
    );
  });

  it('changes when checkers, requireTests or optionalCheckers change', () => {
    const base = hashBaselineCheckerConfig(constitution());
    expect(hashBaselineCheckerConfig(constitution({ checkers: ['tests', 'lint'] }))).not.toBe(base);
    expect(hashBaselineCheckerConfig(constitution({ requireTests: true }))).not.toBe(base);
    expect(hashBaselineCheckerConfig(constitution({ optionalCheckers: ['lint'] }))).not.toBe(base);
  });

  it('gives a 16-hex string for a null constitution', () => {
    expect(hashBaselineCheckerConfig(null)).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('BaselineCache', () => {
  it('misses on a missing file', async () => {
    const cache = new BaselineCache(await cacheFile());
    expect(await cache.get('sha', 'env', 'cfg', 'tests')).toBeUndefined();
  });

  it('round-trips and writes a versioned file', async () => {
    const file = await cacheFile();
    const cache = new BaselineCache(file, () => 0);
    await cache.set('sha', 'env', 'cfg', [out('tests', 'FAIL', 'boom'), out('lint', 'PASS')]);
    expect(await cache.get('sha', 'env', 'cfg', 'tests')).toEqual(out('tests', 'FAIL', 'boom'));
    expect(await cache.get('sha', 'env', 'cfg', 'lint')).toEqual(out('lint', 'PASS'));
    const parsed = JSON.parse(await readFile(file, 'utf-8'));
    expect(parsed.version).toBe(1);
    expect(parsed.entries['sha:env:tests'].recordedAt).toBe('1970-01-01T00:00:00.000Z');
  });

  it('misses on a different envHash or baseSha', async () => {
    const cache = new BaselineCache(await cacheFile());
    await cache.set('sha', 'env', 'cfg', [out('tests', 'FAIL')]);
    expect(await cache.get('sha', 'other', 'cfg', 'tests')).toBeUndefined();
    expect(await cache.get('other', 'env', 'cfg', 'tests')).toBeUndefined();
  });

  it('does not store SKIP outputs and does not create the file for an all-SKIP set', async () => {
    const file = await cacheFile();
    const cache = new BaselineCache(file);
    await cache.set('sha', 'env', 'cfg', [out('tests', 'SKIP')]);
    expect(existsSync(file)).toBe(false);
    await cache.set('sha', 'env', 'cfg', [out('tests', 'SKIP'), out('lint', 'PASS')]);
    expect(await cache.get('sha', 'env', 'cfg', 'tests')).toBeUndefined();
    expect(await cache.get('sha', 'env', 'cfg', 'lint')).toBeDefined();
  });

  it('ignores entries whose stored output does not match', async () => {
    const file = await cacheFile();
    const cache = new BaselineCache(file);
    await cache.set('sha', 'env', 'cfg', [out('tests', 'FAIL')]);
    const parsed = JSON.parse(await readFile(file, 'utf-8'));
    parsed.entries['sha:env:tests'].output.checker = 'lint';
    await writeFile(file, JSON.stringify(parsed));
    expect(await cache.get('sha', 'env', 'cfg', 'tests')).toBeUndefined();
    parsed.entries['sha:env:tests'].output = null;
    await writeFile(file, JSON.stringify(parsed));
    expect(await cache.get('sha', 'env', 'cfg', 'tests')).toBeUndefined();
  });

  it('treats malformed JSON as empty and repairs it on the next set', async () => {
    const file = await cacheFile();
    const cache = new BaselineCache(file);
    await cache.set('sha', 'env', 'cfg', [out('lint', 'PASS')]);
    await writeFile(file, '{not json');
    expect(await cache.get('sha', 'env', 'cfg', 'lint')).toBeUndefined();
    await cache.set('sha', 'env', 'cfg', [out('tests', 'FAIL')]);
    expect(await cache.get('sha', 'env', 'cfg', 'tests')).toBeDefined();
    await writeFile(file, JSON.stringify({ version: 1, entries: [] }));
    expect(await cache.get('sha', 'env', 'cfg', 'tests')).toBeUndefined();
  });

  it('never stores or returns config-error outputs (#2563)', async () => {
    const file = await cacheFile();
    const cache = new BaselineCache(file);
    const bad = [
      unknownCheckerOutput('typecheck'),
      schemaErrorCheckerOutput('checkers', 'is a string, not a list'),
      unfilledPlaceholderCheckerOutput('<Standard Category 1>'),
    ];
    await cache.set('sha', 'env', 'cfg', bad);
    await expect(readFile(file, 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' });
    await cache.set('sha', 'env', 'cfg', [...bad, out('lint', 'PASS')]);
    const parsed = JSON.parse(await readFile(file, 'utf-8'));
    expect(Object.keys(parsed.entries)).toEqual(['sha:env:lint']);
    parsed.entries['sha:env:typecheck'] = {
      output: unknownCheckerOutput('typecheck'),
      configHash: 'cfg',
      recordedAt: '1970-01-01T00:00:00.000Z',
    };
    await writeFile(file, JSON.stringify(parsed));
    expect(await cache.get('sha', 'env', 'cfg', 'typecheck')).toBeUndefined();
  });

  it('misses on a different or missing configHash', async () => {
    const file = await cacheFile();
    const cache = new BaselineCache(file);
    await cache.set('sha', 'env', 'cfg', [out('tests', 'FAIL')]);
    expect(await cache.get('sha', 'env', 'other', 'tests')).toBeUndefined();
    const parsed = JSON.parse(await readFile(file, 'utf-8'));
    delete parsed.entries['sha:env:tests'].configHash;
    await writeFile(file, JSON.stringify(parsed));
    expect(await cache.get('sha', 'env', 'cfg', 'tests')).toBeUndefined();
  });
});
