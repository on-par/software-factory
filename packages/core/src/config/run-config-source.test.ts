import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';
import { getFactoryPaths } from './index.js';
import { loadRepoConfig } from './repo.js';
import { holdRunConfigSnapshot, lastRunConfigLadder, runConfigOrigin, runConfigSource } from './run-config-source.js';

const tmp = createTempDirs();

afterEach(async () => {
  vi.unstubAllEnvs();
  await tmp.cleanup();
});

it('starts each test suite without the parent daemon configuration', () => {
  expect(process.env.FACTORY_RUN_CONFIG_JSON).toBeUndefined();
  expect(process.env.FACTORY_RUN_CONFIG_ORIGIN).toBeUndefined();
});

it('still lets a test explicitly supply a daemon configuration to the real loader', () => {
  vi.stubEnv('FACTORY_RUN_CONFIG_JSON', JSON.stringify({ version: 2, route: 'codex' }));

  expect(loadRepoConfig('/unused-checkout')).toMatchObject({ version: 2, route: 'codex' });
});

/** A source checkout with `.factory/<name>` holding `text`; returns its resolved config path. */
function sourceCheckout(name?: string, text?: string): string {
  const repo = tmp.makeSync('run-config-src-');
  mkdirSync(join(repo, '.factory'), { recursive: true });
  if (name !== undefined) writeFileSync(join(repo, '.factory', name), text ?? '');
  return getFactoryPaths(repo).config;
}

describe('holdRunConfigSnapshot (#3600)', () => {
  it('sets nothing when the source checkout has no config file', () => {
    const release = holdRunConfigSnapshot(sourceCheckout());
    expect(runConfigSource()).toBeUndefined();
    expect(runConfigOrigin()).toBeUndefined();
    release();
    expect(runConfigSource()).toBeUndefined();
  });

  it('snapshots config.yaml so a worktree with no .factory/ loads its checks', () => {
    const config = sourceCheckout('config.yaml', 'version: 2\nchecks:\n  build: make\n  test: make test\n');
    const worktree = tmp.makeSync('run-config-wt-');

    const release = holdRunConfigSnapshot(config);

    expect(runConfigOrigin()).toBe(config);
    expect(loadRepoConfig(worktree)?.checks).toEqual({ build: 'make', test: 'make test' });
    release();
    expect(runConfigSource()).toBeUndefined();
    expect(runConfigOrigin()).toBeUndefined();
    expect(loadRepoConfig(worktree)).toBeNull();
  });

  it('snapshots config.json', () => {
    const config = sourceCheckout('config.json', JSON.stringify({ version: 2, checks: { lint: 'npm run lint' } }));

    const release = holdRunConfigSnapshot(config);

    expect(config.endsWith('config.json')).toBe(true);
    expect(JSON.parse(runConfigSource()!)).toEqual({ version: 2, checks: { lint: 'npm run lint' } });
    expect(runConfigOrigin()).toBe(config);
    release();
  });

  it('leaves a daemon snapshot in place and does not clear it on release', () => {
    const daemon = JSON.stringify({ version: 2, route: 'codex' });
    vi.stubEnv('FACTORY_RUN_CONFIG_JSON', daemon);
    const config = sourceCheckout('config.yaml', 'version: 2\nchecks:\n  test: make test\n');

    const release = holdRunConfigSnapshot(config);
    release();

    expect(runConfigSource()).toBe(daemon);
    expect(runConfigOrigin()).toBeUndefined();
  });

  it('keeps the snapshot until the last concurrent holder releases, and each release counts once', () => {
    const config = sourceCheckout('config.yaml', 'version: 2\n');

    const first = holdRunConfigSnapshot(config);
    const second = holdRunConfigSnapshot(config);
    first();
    first();
    expect(runConfigOrigin()).toBe(config);
    second();
    expect(runConfigSource()).toBeUndefined();
  });

  it('throws naming the file when it is malformed', () => {
    const config = sourceCheckout('config.json', '{ nope');

    expect(() => holdRunConfigSnapshot(config)).toThrow(config);
    expect(runConfigSource()).toBeUndefined();
  });

  it('snapshots a --config file when the checkout has no .factory directory and writes nothing', () => {
    const root = tmp.makeSync('run-config-bare-');
    const file = join(tmp.makeSync('run-config-ext-'), 'config.yaml');
    writeFileSync(file, 'version: 2\nchecks:\n  build: make\n');
    const env = { FACTORY_CONFIG_PATH: file, FACTORY_CONFIG_PATH_SOURCE: '--config' };

    const release = holdRunConfigSnapshot(getFactoryPaths(root).config, env);
    expect(JSON.parse(runConfigSource()!)).toMatchObject({ checks: { build: 'make' } });
    expect(runConfigOrigin()).toBe(file);
    expect(lastRunConfigLadder()?.source).toBe('--config');
    release();
    expect(existsSync(join(root, '.factory'))).toBe(false);
  });

  it('snapshots an override-only run under the override label', () => {
    const root = tmp.makeSync('run-config-frag-');
    const release = holdRunConfigSnapshot(getFactoryPaths(root).config, {
      FACTORY_CONFIG_OVERRIDES: 'disk:\n  minFreeGb: 2\n',
    });
    expect(JSON.parse(runConfigSource()!)).toEqual({ version: 2, disk: { minFreeGb: 2 } });
    expect(runConfigOrigin()).toBe('FACTORY_CONFIG_OVERRIDES');
    release();
  });

  it('an override-only snapshot loads as v2 with no v1 adapter warning for a config file that does not exist (#4018)', () => {
    const root = tmp.makeSync('run-config-frag-v2-');
    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => void warnings.push(args.join(' '));
    try {
      const release = holdRunConfigSnapshot(getFactoryPaths(root).config, {
        FACTORY_CONFIG_OVERRIDES: 'disk:\n  minFreeGb: 2\n',
      });
      expect(loadRepoConfig(root)).toEqual({ version: 2 });
      expect(loadRepoConfig(tmp.makeSync('run-config-frag-wt-'))).toEqual({ version: 2 });
      release();
    } finally {
      console.warn = realWarn;
    }
    expect(warnings).toEqual([]);
    expect(existsSync(getFactoryPaths(root).config)).toBe(false);
  });

  it('a real v1 repo file still loads through the adapter with its migration warning', () => {
    const config = sourceCheckout('config.yaml', 'tiers:\n  worker: [claude-sonnet-5-5]\n');
    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => void warnings.push(args.join(' '));
    try {
      expect(loadRepoConfig(join(config, '..', '..'))).toMatchObject({
        version: 2,
        tiers: { worker: ['claude-sonnet-5-5'] },
      });
    } finally {
      console.warn = realWarn;
    }
    expect(warnings).toEqual([expect.stringContaining(`${config} is v1 — loaded via the v1→v2 compatibility adapter`)]);
  });

  it('a daemon snapshot still wins over overrides', () => {
    vi.stubEnv('FACTORY_RUN_CONFIG_JSON', JSON.stringify({ version: 2, route: 'codex' }));
    const release = holdRunConfigSnapshot(sourceCheckout(), { FACTORY_CONFIG_OVERRIDES: 'disk:\n  minFreeGb: 2\n' });
    expect(JSON.parse(runConfigSource()!)).toEqual({ version: 2, route: 'codex' });
    release();
  });
});
