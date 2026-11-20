import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';
import { loadFactoryConfigForRepo, resolveShipWatchCi, resolveSkipCI } from './index.js';

const tmp = createTempDirs();

function loadShipConfig(body: string) {
  const root = tmp.makeSync('factory-ship-watch-ci-');
  mkdirSync(join(root, '.factory'));
  const path = join(root, '.factory', 'config.yaml');
  writeFileSync(path, body);
  return loadFactoryConfigForRepo(path);
}

describe('resolveShipWatchCi', () => {
  afterEach(() => tmp.cleanup());

  it('defaults to true and is false only for an explicit false', () => {
    expect(resolveShipWatchCi({})).toBe(true);
    expect(resolveShipWatchCi({ ship: {} })).toBe(true);
    expect(resolveShipWatchCi({ ship: { watchCi: true } })).toBe(true);
    expect(resolveShipWatchCi({ ship: { watchCi: false } })).toBe(false);
  });

  it('ship.watchCi false does not set resolveSkipCI, so land keeps its CI gate', () => {
    const cfg = loadShipConfig('version: 2\nship:\n  watchCi: false\n');
    expect(resolveShipWatchCi(cfg)).toBe(false);
    expect(resolveSkipCI(cfg, {})).toBe(false);
  });

  it('a non-boolean ship.watchCi loads and resolves to the default', () => {
    const cfg = loadShipConfig('version: 2\nship:\n  watchCi: nope\n');
    expect(resolveShipWatchCi(cfg)).toBe(true);
  });
});
