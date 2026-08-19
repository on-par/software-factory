import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  defaultRegistryPath,
  dispatchableRepos,
  emptyRegistry,
  getRepo,
  listRepos,
  loadRegistry,
  type RepoRegistry,
  type RepoRegistryEntry,
  upsertRepo,
  writeRegistry,
} from './registry.js';

const tmpDirs: string[] = [];

async function tmpFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'registry-test-'));
  tmpDirs.push(dir);
  return join(dir, 'registry.json');
}

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const goodEntry: RepoRegistryEntry = {
  path: '/tmp/checkout',
  attachedAt: '2026-08-19T12:00:00.000Z',
  state: 'active',
};

describe('loadRegistry', () => {
  it('returns an empty registry for a missing file and creates nothing on disk', async () => {
    const file = await tmpFile();
    const registry = await loadRegistry(file);
    expect(registry).toEqual({ version: 1, repos: {} });
    expect(existsSync(file)).toBe(false);
  });

  it('returns an empty registry for unparsable JSON', async () => {
    const file = await tmpFile();
    await writeFile(file, 'not json{{{');
    const registry = await loadRegistry(file);
    expect(registry).toEqual(emptyRegistry());
  });

  it('returns an empty registry when the top-level payload is a string', async () => {
    const file = await tmpFile();
    await writeFile(file, '"hello"');
    const registry = await loadRegistry(file);
    expect(registry).toEqual(emptyRegistry());
  });

  it('returns an empty registry when the top-level payload is an array', async () => {
    const file = await tmpFile();
    await writeFile(file, '[]');
    const registry = await loadRegistry(file);
    expect(registry).toEqual(emptyRegistry());
  });

  it('retains an entry with state draining', async () => {
    const file = await tmpFile();
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        repos: { 'on-par/software-factory': { ...goodEntry, state: 'draining' } },
      }),
    );
    const registry = await loadRegistry(file);
    expect(registry.repos['on-par/software-factory']).toEqual({ ...goodEntry, state: 'draining' });
  });

  it('drops malformed entries while keeping well-formed siblings', async () => {
    const file = await tmpFile();
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        repos: {
          'on-par/good': goodEntry,
          'on-par/numeric-path': { path: 42, attachedAt: '2026-08-19T12:00:00.000Z', state: 'active' },
          'on-par/bogus-state': { path: '/tmp/x', attachedAt: '2026-08-19T12:00:00.000Z', state: 'bogus' },
          'on-par/missing-attached-at': { path: '/tmp/x', state: 'active' },
        },
      }),
    );
    const registry = await loadRegistry(file);
    expect(Object.keys(registry.repos)).toEqual(['on-par/good']);
    expect(registry.repos['on-par/good']).toEqual(goodEntry);
  });
});

describe('writeRegistry + loadRegistry round trip', () => {
  it('writes then reads back an entry by slug', async () => {
    const file = await tmpFile();
    const registry = upsertRepo(emptyRegistry(), 'on-par/sound-buddy', goodEntry);
    await writeRegistry(file, registry);

    const loaded = await loadRegistry(file);
    expect(getRepo(loaded, 'on-par/sound-buddy')).toEqual(goodEntry);

    const raw = await readFile(file, 'utf-8');
    const parsed = JSON.parse(raw) as RepoRegistry;
    expect(parsed.repos['on-par/sound-buddy']).toEqual(goodEntry);
  });

  it('creates the parent directory on first write', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'registry-test-'));
    tmpDirs.push(dir);
    const file = join(dir, 'nested', '.factory', 'registry.json');
    const registry = upsertRepo(emptyRegistry(), 'on-par/sound-buddy', goodEntry);

    await writeRegistry(file, registry);

    expect(existsSync(file)).toBe(true);
    const loaded = await loadRegistry(file);
    expect(getRepo(loaded, 'on-par/sound-buddy')).toEqual(goodEntry);
  });

  it('leaves the previous file intact when the write crashes before the rename', async () => {
    const file = await tmpFile();
    const v1 = upsertRepo(emptyRegistry(), 'on-par/sound-buddy', goodEntry);
    await writeRegistry(file, v1);

    const v2 = upsertRepo(v1, 'on-par/other', { ...goodEntry, path: '/tmp/other' });
    await expect(
      writeRegistry(file, v2, {
        writeFile: async (f) => {
          await writeFile(f, '{"version":1,"repos":{');
          throw new Error('simulated crash mid-write');
        },
      }),
    ).rejects.toThrow('simulated crash mid-write');

    const loaded = await loadRegistry(file);
    expect(loaded).toEqual(v1);
    const raw = await readFile(file, 'utf-8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it('leaves the previous file intact when the rename crashes', async () => {
    const file = await tmpFile();
    const v1 = upsertRepo(emptyRegistry(), 'on-par/sound-buddy', goodEntry);
    await writeRegistry(file, v1);

    const v2 = upsertRepo(v1, 'on-par/other', { ...goodEntry, path: '/tmp/other' });
    await expect(
      writeRegistry(file, v2, {
        rename: async () => {
          throw new Error('simulated crash during rename');
        },
      }),
    ).rejects.toThrow('simulated crash during rename');

    const loaded = await loadRegistry(file);
    expect(loaded).toEqual(v1);
  });

  it('writes through `${file}.tmp`, never aimed at `file` directly', async () => {
    const file = await tmpFile();
    const registry = upsertRepo(emptyRegistry(), 'on-par/sound-buddy', goodEntry);
    let recordedPath: string | undefined;

    await writeRegistry(file, registry, {
      writeFile: async (f, data) => {
        recordedPath = f;
        await writeFile(f, data);
      },
    });

    expect(recordedPath).toBe(`${file}.tmp`);
  });
});

describe('getRepo', () => {
  it('returns undefined for an unknown slug', () => {
    expect(getRepo(emptyRegistry(), 'on-par/unknown')).toBeUndefined();
  });
});

describe('listRepos', () => {
  it('returns one row per entry, sorted ascending by slug', () => {
    let registry = emptyRegistry();
    registry = upsertRepo(registry, 'z/z', goodEntry);
    registry = upsertRepo(registry, 'a/a', goodEntry);

    const listing = listRepos(registry);

    expect(listing.map((row) => row.slug)).toEqual(['a/a', 'z/z']);
    expect(listing[0]).toEqual({ slug: 'a/a', ...goodEntry });
  });

  it('returns an empty array for an empty registry', () => {
    expect(listRepos(emptyRegistry())).toEqual([]);
  });
});

describe('upsertRepo', () => {
  it('adds a new slug, overwrites an existing one, and does not mutate its input', () => {
    const original = upsertRepo(emptyRegistry(), 'on-par/sound-buddy', goodEntry);

    const updatedEntry: RepoRegistryEntry = { ...goodEntry, state: 'paused' };
    const updated = upsertRepo(original, 'on-par/sound-buddy', updatedEntry);
    const withNew = upsertRepo(updated, 'on-par/second', goodEntry);

    expect(getRepo(withNew, 'on-par/sound-buddy')).toEqual(updatedEntry);
    expect(getRepo(withNew, 'on-par/second')).toEqual(goodEntry);
    expect(getRepo(original, 'on-par/sound-buddy')).toEqual(goodEntry);
  });
});

describe('dispatchableRepos', () => {
  it('returns only active entries, sorted ascending by slug', () => {
    let registry = emptyRegistry();
    registry = upsertRepo(registry, 'z/active', { ...goodEntry, state: 'active' });
    registry = upsertRepo(registry, 'a/active', { ...goodEntry, state: 'active' });
    registry = upsertRepo(registry, 'b/paused', { ...goodEntry, state: 'paused' });
    registry = upsertRepo(registry, 'c/detached', { ...goodEntry, state: 'detached' });
    registry = upsertRepo(registry, 'd/draining', { ...goodEntry, state: 'draining' });

    expect(dispatchableRepos(registry).map((row) => row.slug)).toEqual(['a/active', 'z/active']);
  });

  it('returns an empty array for an empty registry', () => {
    expect(dispatchableRepos(emptyRegistry())).toEqual([]);
  });
});

describe('defaultRegistryPath', () => {
  it('resolves relative to a given home directory', () => {
    expect(defaultRegistryPath('/fake/home')).toBe(join('/fake/home', '.factory', 'registry.json'));
  });

  it('falls back to the real home directory', () => {
    expect(defaultRegistryPath()).toContain(join('.factory', 'registry.json'));
  });
});
