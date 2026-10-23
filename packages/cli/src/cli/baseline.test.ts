import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { getFactoryPaths } from '@on-par/factory-core';
import { BaselineCache } from '@on-par/factory-core/internal';
import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { cmdBaselineClear, runBaselineClear } from './baseline.js';
import { CliExitError, PROGRAM_HANDLERS } from './index.js';

const tmp = createTempDirs();
afterEach(async () => {
  vi.restoreAllMocks();
  await tmp.cleanup();
});

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const checkerOut = (checker: string) => ({ checker, result: 'FAIL' as const, details: '' });

async function setup() {
  const dir = await tmp.make('cli-baseline-');
  const file = join(dir, 'state', 'baseline-cache.json');
  const cache = new BaselineCache(file);
  await cache.set(SHA_A, 'env', 'cfg', [checkerOut('tests'), checkerOut('lint')]);
  await cache.set(SHA_B, 'env', 'cfg', [checkerOut('tests')]);
  const out: string[] = [];
  return { dir, file, cache, out, deps: { cache, out: (l: string) => out.push(l) } };
}

describe('factory baseline clear (#3540)', () => {
  it('removes every entry and prints the count', async () => {
    const { cache, out, deps } = await setup();
    expect(await runBaselineClear({}, deps)).toBe(3);
    expect(out).toEqual(['removed 3 baseline cache entries']);
    expect(await cache.get(SHA_A, 'env', 'cfg', 'tests')).toBeUndefined();
  });

  it("--sha removes only that SHA's entries and prints the count", async () => {
    const { cache, out, deps } = await setup();
    expect(await runBaselineClear({ sha: SHA_B }, deps)).toBe(1);
    expect(out).toEqual([`removed 1 baseline cache entry for ${SHA_B}`]);
    expect(await cache.get(SHA_B, 'env', 'cfg', 'tests')).toBeUndefined();
    expect(await cache.get(SHA_A, 'env', 'cfg', 'tests')).toBeDefined();
  });

  it('leaves every other state file byte-identical', async () => {
    const { dir, file, deps } = await setup();
    const stateDir = join(dir, 'state');
    const others = ['events.ndjson', 'breaker.json', 'base-hold.json'];
    for (const name of others) await writeFile(join(stateDir, name), `${name} content\n`);
    const snap = async () =>
      Promise.all(
        others.map(async (n) => [
          n,
          await readFile(join(stateDir, n), 'utf-8'),
          (await stat(join(stateDir, n))).mtimeMs,
        ]),
      );
    const before = await snap();
    await runBaselineClear({}, deps);
    expect(await snap()).toEqual(before);
    expect((await readdir(stateDir)).sort()).toEqual([...others, 'baseline-cache.json'].sort());
    expect(file).toContain('baseline-cache.json');
  });

  it('rejects a non-hex --sha with exit 2', async () => {
    const { deps } = await setup();
    const err = await runBaselineClear({ sha: 'zzzz' }, deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliExitError);
    expect((err as CliExitError).code).toBe(2);
  });

  it('prints removed 0 baseline cache entries and creates no file when the cache is missing', async () => {
    const dir = await tmp.make('cli-baseline-empty-');
    const file = join(dir, 'state', 'baseline-cache.json');
    const out: string[] = [];
    expect(await runBaselineClear({}, { cache: new BaselineCache(file), out: (l) => out.push(l) })).toBe(0);
    expect(out).toEqual(['removed 0 baseline cache entries']);
    await mkdir(dir, { recursive: true });
    expect(await readdir(dir)).toEqual([]);
  });

  it('cmdBaselineClear clears the repo state cache', async () => {
    const repo = await tmp.make('cli-baseline-repo-');
    const file = getFactoryPaths(repo).baselineCache;
    await new BaselineCache(file).set(SHA_A, 'env', 'cfg', [checkerOut('tests')]);
    vi.spyOn(PROGRAM_HANDLERS, 'getRepoRoot').mockResolvedValue(repo);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await cmdBaselineClear({});
    expect(log).toHaveBeenCalledWith('removed 1 baseline cache entry');
  });
});
