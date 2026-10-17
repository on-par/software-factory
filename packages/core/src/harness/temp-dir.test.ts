import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createTempDirs, withTempDir } from './temp-dir.js';

describe('createTempDirs', () => {
  it('makes dirs under tmpdir with the prefix and removes them all on cleanup', async () => {
    const tmp = createTempDirs();
    const a = await tmp.make('temp-dir-test-');
    const b = tmp.makeSync('temp-dir-test-');
    expect(dirname(a)).toBe(tmpdir());
    expect(basename(b).startsWith('temp-dir-test-')).toBe(true);
    expect(existsSync(a) && existsSync(b)).toBe(true);
    await tmp.cleanup();
    expect(existsSync(a) || existsSync(b)).toBe(false);
    await expect(tmp.cleanup()).resolves.toBeUndefined();
  });

  it('cleanup removes every registered dir even after the test body threw', async () => {
    const tmp = createTempDirs();
    const dirs = [await tmp.make('temp-dir-test-'), tmp.makeSync('temp-dir-test-')];
    try {
      throw new Error('test body failed');
    } catch {
      // the body failed; afterEach still cleans up
    }
    await tmp.cleanup();
    expect(dirs.some((dir) => existsSync(dir))).toBe(false);
  });
});

describe('withTempDir', () => {
  it('returns fn result and removes the dir', async () => {
    let seen = '';
    const value = await withTempDir('temp-dir-test-', (dir) => {
      seen = dir;
      expect(existsSync(dir)).toBe(true);
      return 42;
    });
    expect(value).toBe(42);
    expect(existsSync(seen)).toBe(false);
  });

  it('withTempDir removes its dir when fn throws', async () => {
    let seen = '';
    await expect(
      withTempDir('temp-dir-test-', (dir) => {
        seen = dir;
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(seen).not.toBe('');
    expect(existsSync(seen)).toBe(false);
  });
});
