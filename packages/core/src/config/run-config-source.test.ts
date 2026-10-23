import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';
import { getFactoryPaths } from './index.js';
import { loadRepoConfig } from './repo.js';
import { holdRunConfigSnapshot, runConfigOrigin, runConfigSource } from './run-config-source.js';

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
});
