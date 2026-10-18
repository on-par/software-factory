import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { execa } from 'execa';
import { afterEach, describe, expect, it } from 'vitest';

import { parseCheckoutRequest, readOriginUrl, validateCheckout } from './checkout-validation.js';
import { parseRemoteSlug } from './remote-slug.js';

const tmpDirs: string[] = [];

async function tmpDir(prefix = 'checkout-validation-test-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('validateCheckout', () => {
  async function checkoutWithConfig(): Promise<string> {
    const dir = await tmpDir();
    await mkdir(join(dir, '.factory'), { recursive: true });
    await writeFile(join(dir, '.factory', 'config.json'), '{}');
    return dir;
  }

  it('passes a matching origin with factory config (acceptance criterion 1)', async () => {
    const dir = await checkoutWithConfig();

    await expect(
      validateCheckout(
        { repo: 'on-par/software-factory', path: dir },
        { readOrigin: async () => 'git@github.com:on-par/software-factory.git' },
      ),
    ).resolves.toEqual({
      ok: true,
      checkout: {
        repo: 'on-par/software-factory',
        dir,
        originSlug: 'on-par/software-factory',
        configFile: join(dir, '.factory', 'config.json'),
      },
    });
  });

  async function checkoutWith(names: string[]): Promise<string> {
    const dir = await tmpDir();
    await mkdir(join(dir, '.factory'), { recursive: true });
    for (const name of names) {
      await writeFile(join(dir, '.factory', name), 'version: 2\n');
    }
    return dir;
  }

  async function configFileFor(dir: string): Promise<unknown> {
    const result = await validateCheckout(
      { repo: 'on-par/software-factory', path: dir },
      { readOrigin: async () => 'git@github.com:on-par/software-factory.git' },
    );
    return result.ok ? result.checkout.configFile : result;
  }

  it('validateCheckout accepts a checkout initialized with .factory/config.yaml', async () => {
    const dir = await checkoutWith(['config.yaml']);

    await expect(
      validateCheckout(
        { repo: 'on-par/software-factory', path: dir },
        { readOrigin: async () => 'git@github.com:on-par/software-factory.git' },
      ),
    ).resolves.toEqual({
      ok: true,
      checkout: {
        repo: 'on-par/software-factory',
        dir,
        originSlug: 'on-par/software-factory',
        configFile: join(dir, '.factory', 'config.yaml'),
      },
    });
  });

  it('accepts a checkout with only .factory/config.yml', async () => {
    const dir = await checkoutWith(['config.yml']);

    expect(await configFileFor(dir)).toBe(join(dir, '.factory', 'config.yml'));
  });

  it('prefers config.yaml over config.json when both exist', async () => {
    const dir = await checkoutWith(['config.json', 'config.yaml']);

    expect(await configFileFor(dir)).toBe(join(dir, '.factory', 'config.yaml'));
  });

  it('rejects an origin mismatch (acceptance criterion 2)', async () => {
    const dir = await checkoutWithConfig();

    await expect(
      validateCheckout(
        { repo: 'on-par/software-factory', path: dir },
        { readOrigin: async () => 'git@github.com:on-par/other-repo.git' },
      ),
    ).resolves.toEqual({
      ok: false,
      reason: 'origin-mismatch',
      detail: 'origin is on-par/other-repo, not on-par/software-factory',
    });
  });

  it('rejects a missing factory config (acceptance criterion 3)', async () => {
    const dir = await tmpDir();

    await expect(
      validateCheckout(
        { repo: 'on-par/software-factory', path: dir },
        { readOrigin: async () => 'git@github.com:on-par/software-factory.git' },
      ),
    ).resolves.toEqual({
      ok: false,
      reason: 'missing-factory-config',
      detail: `no repo config in ${join(dir, '.factory')} (looked for config.yaml, config.yml, config.json)`,
    });
  });

  it('rejects a factory config that is a directory', async () => {
    const dir = await tmpDir();
    await mkdir(join(dir, '.factory', 'config.json'), { recursive: true });

    await expect(
      validateCheckout(
        { repo: 'on-par/software-factory', path: dir },
        { readOrigin: async () => 'git@github.com:on-par/software-factory.git' },
      ),
    ).resolves.toEqual({
      ok: false,
      reason: 'missing-factory-config',
      detail: `no repo config in ${join(dir, '.factory')} (looked for config.yaml, config.yml, config.json)`,
    });
  });

  it('rejects a path that is not a git checkout', async () => {
    const dir = await checkoutWithConfig();

    await expect(
      validateCheckout({ repo: 'on-par/software-factory', path: dir }, { readOrigin: async () => null }),
    ).resolves.toEqual({
      ok: false,
      reason: 'not-a-git-checkout',
      detail: `${dir} is not a git checkout with an origin remote`,
    });
  });

  it('rejects an origin URL that does not parse to owner/name', async () => {
    const dir = await checkoutWithConfig();

    await expect(
      validateCheckout({ repo: 'on-par/software-factory', path: dir }, { readOrigin: async () => 'nonsense' }),
    ).resolves.toEqual({
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
    const result = await validateCheckout(body);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('invalid-request');
      expect(result.detail.length).toBeGreaterThan(0);
    }
  });

  it('matches slugs case-insensitively while preserving the posted casing', async () => {
    const dir = await checkoutWithConfig();

    const result = await validateCheckout(
      { repo: 'On-Par/Software-Factory', path: dir },
      { readOrigin: async () => 'git@github.com:on-par/software-factory.git' },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.checkout.repo).toBe('On-Par/Software-Factory');
      expect(result.checkout.originSlug).toBe('on-par/software-factory');
    }
  });

  it('resolves an absolute path with trailing and dot segments', async () => {
    const dir = await checkoutWithConfig();
    const path = `${dir}/./`;

    const result = await validateCheckout(
      { repo: 'on-par/software-factory', path },
      { readOrigin: async () => 'git@github.com:on-par/software-factory.git' },
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.checkout.dir).toBe(resolve(path));
  });
});

describe('parseCheckoutRequest', () => {
  it('returns a valid request unchanged', () => {
    expect(parseCheckoutRequest({ repo: 'on-par/software-factory', path: '/tmp/checkout' })).toEqual({
      ok: true,
      request: { repo: 'on-par/software-factory', path: '/tmp/checkout' },
    });
  });

  it('reports malformed request bodies exactly', () => {
    expect(parseCheckoutRequest(null)).toEqual({
      ok: false,
      detail: 'expected { repo: "owner/name", path: "/abs/path" }',
    });
  });

  it('reports malformed slugs exactly', () => {
    expect(parseCheckoutRequest({ repo: 'invalid', path: '/tmp/checkout' })).toEqual({
      ok: false,
      detail: 'repo must be an "owner/name" slug, got "invalid"',
    });
  });

  it('reports relative paths exactly', () => {
    expect(parseCheckoutRequest({ repo: 'on-par/software-factory', path: 'relative' })).toEqual({
      ok: false,
      detail: 'path must be absolute',
    });
  });
});

describe('readOriginUrl', () => {
  it('returns the origin remote URL for a real git checkout', async () => {
    const dir = await tmpDir();
    await execa('git', ['init'], { cwd: dir });
    await execa('git', ['remote', 'add', 'origin', 'https://github.com/on-par/software-factory.git'], { cwd: dir });

    const origin = await readOriginUrl(dir);
    expect(parseRemoteSlug(origin ?? '')).toBe('on-par/software-factory');
  });

  it('returns null for a directory that is not a git checkout', async () => {
    const dir = await tmpDir();
    await expect(readOriginUrl(dir)).resolves.toBeNull();
  });
});

describe('validateCheckout with a stateRoot', () => {
  const readOrigin = async () => 'git@github.com:on-par/software-factory.git';
  const base = { repo: 'on-par/software-factory', path: '/tmp/some-checkout' };

  it('accepts a body stateRoot with no in-checkout config', async () => {
    await expect(
      validateCheckout({ ...base, stateRoot: '/ext/root' }, { readOrigin, fileExists: async () => false }),
    ).resolves.toEqual({
      ok: true,
      checkout: {
        repo: base.repo,
        dir: base.path,
        originSlug: base.repo,
        configFile: null,
        stateRoot: '/ext/root',
      },
    });
  });

  it('resolves auto with deps.home', async () => {
    const r = await validateCheckout(
      { ...base, stateRoot: 'auto' },
      { readOrigin, fileExists: async () => false, home: '/h' },
    );
    expect(r.ok && r.checkout.stateRoot).toBe(join('/h', '.factory', 'on-par', 'software-factory'));
  });

  it('rejects an invalid stateRoot as invalid-request', async () => {
    for (const stateRoot of ['rel/path', '', 5]) {
      await expect(validateCheckout({ ...base, stateRoot }, { readOrigin })).resolves.toMatchObject({
        ok: false,
        reason: 'invalid-request',
        detail: 'stateRoot must be an absolute path or "auto"',
      });
    }
  });

  it('existingStateRoot skips the config check', async () => {
    const r = await validateCheckout(base, { readOrigin, fileExists: async () => false }, '/existing');
    expect(r).toMatchObject({ ok: true, checkout: { configFile: null, stateRoot: '/existing' } });
  });

  it('still fails missing-factory-config with no stateRoot', async () => {
    await expect(validateCheckout(base, { readOrigin, fileExists: async () => false })).resolves.toMatchObject({
      ok: false,
      reason: 'missing-factory-config',
    });
  });
});
