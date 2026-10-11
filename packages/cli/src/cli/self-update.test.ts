// packages/cli/src/cli/self-update.test.ts — factory self-update --check (#2354)
import { describe, expect, it } from 'vitest';

import { DaemonCtlError } from './daemon.js';
import {
  checkForUpdate,
  cmdSelfUpdateCheck,
  compareSemver,
  fetchDistTags,
  formatUpdateCheck,
  parseSemver,
  selectCandidate,
  type RegistryFetch,
  type SelfUpdateDeps,
} from './self-update.js';

const tagsFetch =
  (tags: unknown, status = 200): RegistryFetch =>
  async () => ({ status, body: JSON.stringify(tags) });

function setup(
  version: string,
  fetch: RegistryFetch,
  env: NodeJS.ProcessEnv = {},
): { deps: SelfUpdateDeps; out: string[] } {
  const out: string[] = [];
  return {
    out,
    deps: {
      fetch,
      out: { write: (s: string) => out.push(s) },
      install: {
        version,
        env,
        execPath: '/usr/local/bin/node',
        cliPath: '/usr/local/lib/node_modules/@on-par/factory-cli/dist/cli.js',
        exists: () => false,
      },
    },
  };
}

describe('compareSemver', () => {
  it('orders numerically, release above prerelease, and prerelease ids per semver', () => {
    expect(compareSemver('0.9.10', '0.9.9')).toBe(1);
    expect(compareSemver('0.9.9', '0.9.10')).toBe(-1);
    expect(compareSemver('1.0.0', '0.9.9')).toBe(1);
    expect(compareSemver('0.10.0', '0.9.0')).toBe(1);
    expect(compareSemver('0.9.1', '0.9.1-alpha.3')).toBe(1);
    expect(compareSemver('0.9.1-alpha.3', '0.9.1')).toBe(-1);
    expect(compareSemver('1.0.0-alpha.2', '1.0.0-alpha.10')).toBe(-1);
    expect(compareSemver('1.0.0-alpha', '1.0.0-beta')).toBe(-1);
    expect(compareSemver('1.0.0-beta', '1.0.0-alpha')).toBe(1);
    expect(compareSemver('1.0.0-1', '1.0.0-alpha')).toBe(-1);
    expect(compareSemver('1.0.0-alpha', '1.0.0-1')).toBe(1);
    expect(compareSemver('1.0.0-alpha', '1.0.0-alpha.1')).toBe(-1);
    expect(compareSemver('1.0.0-alpha.1', '1.0.0-alpha')).toBe(1);
    expect(compareSemver('1.0.0-alpha.1', '1.0.0-alpha.1')).toBe(0);
    expect(compareSemver('1.2.3+a', '1.2.3+b')).toBe(0);
    expect(compareSemver('v1.2.3', '1.2.3')).toBe(0);
  });
  it('throws on malformed input', () => {
    expect(() => compareSemver('x', '1.0.0')).toThrow(/invalid version/);
    expect(() => compareSemver('1.0.0', 'x')).toThrow(/invalid version/);
  });
});

describe('parseSemver', () => {
  it('returns null for non-semver', () => {
    for (const v of ['', '1.2', 'latest', '1.2.3-']) expect(parseSemver(v)).toBeNull();
  });
  it('parses prerelease parts', () => {
    expect(parseSemver('1.2.3-alpha.1')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: ['alpha', '1'] });
    expect(parseSemver('1.2.3')?.prerelease).toEqual([]);
  });
});

describe('selectCandidate', () => {
  it('stable reads only a non-prerelease latest', () => {
    expect(selectCandidate({ latest: '0.9.1', next: '0.9.2-alpha.1' }, 'stable')).toBe('0.9.1');
    expect(selectCandidate({ latest: '0.9.1-alpha.3', next: '0.9.2' }, 'stable')).toBeNull();
    expect(selectCandidate({ next: '0.9.2' }, 'stable')).toBeNull();
    expect(selectCandidate({ latest: 'bogus' }, 'stable')).toBeNull();
  });
  it('prerelease picks the highest of next and latest', () => {
    expect(selectCandidate({ latest: '0.9.1', next: '0.9.2-alpha.1' }, 'prerelease')).toBe('0.9.2-alpha.1');
    expect(selectCandidate({ latest: '0.9.3', next: '0.9.2-alpha.1' }, 'prerelease')).toBe('0.9.3');
    expect(selectCandidate({ latest: 'bogus', next: '0.9.2-alpha.1' }, 'prerelease')).toBe('0.9.2-alpha.1');
    expect(selectCandidate({}, 'prerelease')).toBeNull();
    expect(selectCandidate({ next: 'bogus' }, 'prerelease')).toBeNull();
  });
});

describe('fetchDistTags', () => {
  it('builds the dist-tags URL and honours a custom registry', async () => {
    const urls: string[] = [];
    const f: RegistryFetch = async (url) => {
      urls.push(url);
      return { status: 200, body: '{"latest":"1.0.0"}' };
    };
    expect(await fetchDistTags(f)).toEqual({ latest: '1.0.0' });
    await fetchDistTags(f, { registry: 'https://r.example/', timeoutMs: 5 });
    expect(urls).toEqual([
      'https://registry.npmjs.org/-/package/%40on-par%2Ffactory-cli/dist-tags',
      'https://r.example/-/package/%40on-par%2Ffactory-cli/dist-tags',
    ]);
  });
  it('rejects on HTTP errors and malformed bodies', async () => {
    await expect(fetchDistTags(tagsFetch({}, 503))).rejects.toThrow('HTTP 503');
    await expect(fetchDistTags(async () => ({ status: 200, body: 'nope' }))).rejects.toThrow('malformed');
    await expect(fetchDistTags(tagsFetch(['1.0.0']))).rejects.toThrow('malformed');
    await expect(fetchDistTags(tagsFetch(null))).rejects.toThrow('malformed');
    await expect(fetchDistTags(tagsFetch({ latest: 1 }))).rejects.toThrow('malformed');
  });
  it('rewrites timeouts and propagates other failures', async () => {
    const timeout = async () => {
      throw Object.assign(new Error('x'), { name: 'TimeoutError' });
    };
    await expect(fetchDistTags(timeout, { timeoutMs: 7 })).rejects.toThrow('timed out after 7 ms');
    await expect(
      fetchDistTags(async () => {
        throw new Error('ECONNREFUSED');
      }),
    ).rejects.toThrow('ECONNREFUSED');
    await expect(
      fetchDistTags(async () => {
        throw 'boom';
      }),
    ).rejects.toBe('boom');
  });
});

describe('cmdSelfUpdateCheck', () => {
  it('reports an available stable update as JSON with exit 10', async () => {
    const { deps, out } = setup('0.9.0', tagsFetch({ latest: '0.9.1' }));
    expect(await cmdSelfUpdateCheck({ json: true }, deps)).toBe(10);
    expect(JSON.parse(out.join(''))).toMatchObject({
      updateAvailable: true,
      candidate: '0.9.1',
      channel: 'latest',
      installKind: 'npm-global',
      applies: true,
      error: null,
    });
  });

  it('reports up to date with exit 0', async () => {
    const { deps, out } = setup('0.9.1', tagsFetch({ latest: '0.9.1' }));
    expect(await cmdSelfUpdateCheck({ json: true }, deps)).toBe(0);
    expect(JSON.parse(out.join('')).updateAvailable).toBe(false);
    const older = setup('0.9.2', tagsFetch({ latest: '0.9.1' }));
    expect(await cmdSelfUpdateCheck({ json: true }, older.deps)).toBe(0);
  });

  it('never offers a prerelease on the stable channel', async () => {
    const { deps, out } = setup('0.9.0', tagsFetch({ latest: '0.9.1-alpha.3', next: '0.9.2-alpha.1' }));
    expect(await cmdSelfUpdateCheck({ json: true }, deps)).toBe(0);
    expect(JSON.parse(out.join(''))).toMatchObject({ updateAvailable: false, candidate: null, error: null });
  });

  it('reports a 503 and a timeout as errors with exit 1', async () => {
    const bad = setup('0.9.0', tagsFetch({ latest: '0.9.1' }, 503));
    expect(await cmdSelfUpdateCheck({ json: true }, bad.deps)).toBe(1);
    const r1 = JSON.parse(bad.out.join(''));
    expect(r1).toMatchObject({ updateAvailable: false, candidate: null });
    expect(r1.error).toBeTruthy();
    const slow = setup('0.9.0', async () => {
      throw Object.assign(new Error('x'), { name: 'TimeoutError' });
    });
    expect(await cmdSelfUpdateCheck({ json: true }, slow.deps)).toBe(1);
    const r2 = JSON.parse(slow.out.join(''));
    expect(r2).toMatchObject({ updateAvailable: false, candidate: null });
    expect(r2.error).toMatch(/timed out/);
  });

  it('marks a source install applies false', async () => {
    const { deps, out } = setup('0.9.0', tagsFetch({ latest: '0.9.1' }), { FACTORY_FROM_SOURCE: '1' });
    await cmdSelfUpdateCheck({ json: true }, deps);
    expect(JSON.parse(out.join(''))).toMatchObject({
      installKind: 'source',
      applies: false,
      current: '0.9.0',
      candidate: '0.9.1',
    });
  });

  it('checks the next channel in prerelease mode', async () => {
    const { deps, out } = setup('0.9.0', tagsFetch({ latest: '0.9.0', next: '0.9.2-alpha.1' }));
    expect(await cmdSelfUpdateCheck({ json: true, updateMode: 'prerelease' }, deps)).toBe(10);
    expect(JSON.parse(out.join(''))).toMatchObject({ candidate: '0.9.2-alpha.1', channel: 'next' });
  });

  it('prints a human line without --json', async () => {
    const ok = setup('0.9.0', tagsFetch({ latest: '0.9.1' }));
    await cmdSelfUpdateCheck({}, ok.deps);
    expect(ok.out.join('')).toContain('0.9.0');
    expect(ok.out.join('')).toContain('0.9.1');
    expect(ok.out.join('')).toContain('latest');
    const bad = setup('0.9.0', tagsFetch({}, 503));
    await cmdSelfUpdateCheck({}, bad.deps);
    expect(bad.out.join('')).toContain('registry returned HTTP 503');
  });

  it('rejects manual and invalid update modes with code 2', async () => {
    for (const updateMode of ['manual', 'bogus']) {
      const { deps } = setup('0.9.0', tagsFetch({}));
      const err = await cmdSelfUpdateCheck({ updateMode }, deps).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DaemonCtlError);
      expect((err as DaemonCtlError).code).toBe(2);
    }
  });
});

describe('formatUpdateCheck', () => {
  it('notes when an update does not apply, and stringifies non-Error failures', async () => {
    const { deps } = setup('0.9.0', tagsFetch({ latest: '0.9.1' }), { FACTORY_FROM_SOURCE: '1' });
    const r = await checkForUpdate('stable', deps);
    expect(formatUpdateCheck(r)).toContain('not applied to a source install');
    const failed = await checkForUpdate('stable', {
      ...deps,
      fetch: async () => {
        throw 'boom';
      },
    });
    expect(failed.error).toBe('boom');
  });
});
