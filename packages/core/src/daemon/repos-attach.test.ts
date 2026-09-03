import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execa } from 'execa';
import { afterEach, describe, expect, it } from 'vitest';

import { attachRepo, parseRemoteSlug, readOriginUrl } from './repos-attach.js';

/** The local git host may rewrite remote URLs (e.g. a global `url.insteadOf`
 *  mapping https:// to an scp-style URL), so readOriginUrl's raw return value
 *  is environment-dependent. Compare via parseRemoteSlug instead of the raw
 *  string so this test is robust to that rewrite. */

const tmpDirs: string[] = [];

async function tmpDir(prefix = 'repos-attach-test-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('parseRemoteSlug', () => {
  it.each([
    ['git@github.com:on-par/software-factory.git', 'on-par/software-factory'],
    ['https://github.com/on-par/software-factory', 'on-par/software-factory'],
    ['https://github.com/on-par/software-factory.git/', 'on-par/software-factory'],
    ['ssh://git@github.com/on-par/software-factory.git', 'on-par/software-factory'],
  ])('parses %s -> %s', (url, expected) => {
    expect(parseRemoteSlug(url)).toBe(expected);
  });

  it.each([[''], ['nonsense'], ['https://github.com/only-one-segment']])('returns null for %s', (url) => {
    expect(parseRemoteSlug(url)).toBeNull();
  });
});

describe('readOriginUrl', () => {
  it('returns the origin remote URL for a real git checkout', async () => {
    const dir = await tmpDir();
    await execa('git', ['init'], { cwd: dir });
    await execa('git', ['remote', 'add', 'origin', 'https://github.com/on-par/software-factory.git'], { cwd: dir });

    const origin = await readOriginUrl(dir);
    expect(origin).not.toBeNull();
    expect(parseRemoteSlug(origin ?? '')).toBe('on-par/software-factory');
  });

  it('returns null for a directory that is not a git checkout', async () => {
    const dir = await tmpDir();
    await expect(readOriginUrl(dir)).resolves.toBeNull();
  });
});

describe('attachRepo', () => {
  async function checkoutWithConfig(): Promise<string> {
    const dir = await tmpDir();
    await mkdir(join(dir, '.factory'), { recursive: true });
    await writeFile(join(dir, '.factory', 'config.json'), '{}');
    return dir;
  }

  it('attaches a valid checkout and persists it to the registry (acceptance criterion 1)', async () => {
    const dir = await checkoutWithConfig();
    const registryFile = join(await tmpDir(), 'registry.json');
    const fixedDate = new Date('2026-08-19T12:00:00.000Z');

    const result = await attachRepo(
      registryFile,
      { repo: 'on-par/software-factory', path: dir },
      {
        readOrigin: async () => 'git@github.com:on-par/software-factory.git',
        now: () => fixedDate,
      },
    );

    expect(result).toEqual({
      ok: true,
      entry: { slug: 'on-par/software-factory', path: dir, attachedAt: '2026-08-19T12:00:00.000Z', state: 'active' },
    });

    const raw = await readFile(registryFile, 'utf-8');
    const parsed = JSON.parse(raw) as { repos: Record<string, unknown> };
    expect(parsed.repos['on-par/software-factory']).toEqual({
      path: dir,
      attachedAt: '2026-08-19T12:00:00.000Z',
      state: 'active',
    });
  });

  it('rejects an origin mismatch and leaves a pre-existing registry byte-for-byte unchanged (acceptance criterion 2)', async () => {
    const dir = await checkoutWithConfig();
    const registryFile = join(await tmpDir(), 'registry.json');
    const preSeeded = JSON.stringify({
      version: 1,
      repos: {
        'on-par/unrelated': { path: '/tmp/unrelated', attachedAt: '2026-01-01T00:00:00.000Z', state: 'active' },
      },
    });
    await writeFile(registryFile, preSeeded);

    const result = await attachRepo(
      registryFile,
      { repo: 'on-par/software-factory', path: dir },
      {
        readOrigin: async () => 'git@github.com:on-par/other-repo.git',
      },
    );

    expect(result).toEqual({
      ok: false,
      reason: 'origin-mismatch',
      detail: 'origin is on-par/other-repo, not on-par/software-factory',
    });
    await expect(readFile(registryFile, 'utf-8')).resolves.toBe(preSeeded);
  });

  it('rejects a missing .factory/config.json and never creates the registry file (acceptance criterion 3)', async () => {
    const dir = await tmpDir();
    const registryFile = join(await tmpDir(), 'registry.json');

    const result = await attachRepo(
      registryFile,
      { repo: 'on-par/software-factory', path: dir },
      {
        readOrigin: async () => 'git@github.com:on-par/software-factory.git',
      },
    );

    expect(result).toEqual({
      ok: false,
      reason: 'missing-factory-config',
      detail: `${join(dir, '.factory', 'config.json')} not found`,
    });
    expect(existsSync(registryFile)).toBe(false);
  });

  it('rejects a path that is not a git checkout', async () => {
    const dir = await checkoutWithConfig();
    const registryFile = join(await tmpDir(), 'registry.json');

    const result = await attachRepo(
      registryFile,
      { repo: 'on-par/software-factory', path: dir },
      {
        readOrigin: async () => null,
      },
    );

    expect(result).toEqual({
      ok: false,
      reason: 'not-a-git-checkout',
      detail: `${dir} is not a git checkout with an origin remote`,
    });
  });

  it('rejects an origin URL that does not parse to owner/name', async () => {
    const dir = await checkoutWithConfig();
    const registryFile = join(await tmpDir(), 'registry.json');

    const result = await attachRepo(
      registryFile,
      { repo: 'on-par/software-factory', path: dir },
      {
        readOrigin: async () => 'nonsense',
      },
    );

    expect(result).toEqual({
      ok: false,
      reason: 'not-a-git-checkout',
      detail: 'origin remote "nonsense" does not parse to owner/name',
    });
  });

  it.each([
    [null],
    ['a string'],
    [[]],
    [{}],
    [{ repo: 'no-slash', path: '/tmp/x' }],
    [{ repo: 'a/b', path: 'relative/path' }],
  ])('rejects invalid request body %j', async (body) => {
    const registryFile = join(await tmpDir(), 'registry.json');
    const result = await attachRepo(registryFile, body);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('invalid-request');
      expect(result.detail.length).toBeGreaterThan(0);
    }
  });

  it('matches slugs case-insensitively but keys the registry entry by the posted slug', async () => {
    const dir = await checkoutWithConfig();
    const registryFile = join(await tmpDir(), 'registry.json');

    const result = await attachRepo(
      registryFile,
      { repo: 'On-Par/Software-Factory', path: dir },
      {
        readOrigin: async () => 'git@github.com:on-par/software-factory.git',
      },
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.entry.slug).toBe('On-Par/Software-Factory');
  });

  it('re-attaching an already-registered slug overwrites its entry and leaves siblings untouched', async () => {
    const dir = await checkoutWithConfig();
    const registryFile = join(await tmpDir(), 'registry.json');
    await writeFile(
      registryFile,
      JSON.stringify({
        version: 1,
        repos: {
          'on-par/software-factory': { path: '/old/path', attachedAt: '2020-01-01T00:00:00.000Z', state: 'active' },
          'on-par/sibling': { path: '/sibling', attachedAt: '2020-01-01T00:00:00.000Z', state: 'paused' },
        },
      }),
    );

    const result = await attachRepo(
      registryFile,
      { repo: 'on-par/software-factory', path: dir },
      {
        readOrigin: async () => 'git@github.com:on-par/software-factory.git',
        now: () => new Date('2026-08-19T12:00:00.000Z'),
      },
    );

    expect(result).toEqual({
      ok: true,
      entry: { slug: 'on-par/software-factory', path: dir, attachedAt: '2026-08-19T12:00:00.000Z', state: 'active' },
    });

    const raw = await readFile(registryFile, 'utf-8');
    const parsed = JSON.parse(raw) as { repos: Record<string, { path: string; state: string }> };
    expect(parsed.repos['on-par/software-factory'].path).toBe(dir);
    expect(parsed.repos['on-par/sibling']).toEqual({
      path: '/sibling',
      attachedAt: '2020-01-01T00:00:00.000Z',
      state: 'paused',
    });
  });

  it('rejects when .factory/config.json is a directory, not a file', async () => {
    const dir = await tmpDir();
    await mkdir(join(dir, '.factory', 'config.json'), { recursive: true });
    const registryFile = join(await tmpDir(), 'registry.json');

    const result = await attachRepo(
      registryFile,
      { repo: 'on-par/software-factory', path: dir },
      {
        readOrigin: async () => 'git@github.com:on-par/software-factory.git',
      },
    );

    expect(result).toEqual({
      ok: false,
      reason: 'missing-factory-config',
      detail: `${join(dir, '.factory', 'config.json')} not found`,
    });
  });
});
