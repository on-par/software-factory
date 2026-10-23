// #3467
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';
import { judgeReadiness } from './judge.js';
import type { ReadinessVerdict } from './judge.js';
import { readCachedVerdict, readinessCacheKey, writeCachedVerdict } from './judge-cache.js';

const verdict: ReadinessVerdict = { schemaVersion: 1, verdict: 'ready', summary: 's', assumptions: [], questions: [] };
const tempDirs = createTempDirs();
let dir: string;
beforeEach(() => {
  dir = tempDirs.makeSync('jcache-');
});
afterEach(async () => {
  await tempDirs.cleanup();
});

const entryFor = (key: string) => ({
  schemaVersion: 1 as const,
  promptVersion: 'v',
  bodyHash: key,
  model: 'm',
  verdict,
  createdAt: 'now',
});

describe('readiness cache', () => {
  it('derives a deterministic 32-hex key that varies with each input', () => {
    const k = readinessCacheKey('v1', 't', 'b');
    expect(k).toMatch(/^[0-9a-f]{32}$/);
    expect(readinessCacheKey('v1', 't', 'b')).toBe(k);
    expect(readinessCacheKey('v2', 't', 'b')).not.toBe(k);
    expect(readinessCacheKey('v1', 'u', 'b')).not.toBe(k);
    expect(readinessCacheKey('v1', 't', 'c')).not.toBe(k);
  });

  it('round-trips an entry and leaves no temp files', () => {
    const key = readinessCacheKey('v', 't', 'b');
    writeCachedVerdict(dir, key, entryFor(key));
    expect(readCachedVerdict(dir, key)).toEqual(entryFor(key));
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('treats corrupt, mismatched, missing and non-object entries as misses', () => {
    writeFileSync(join(dir, 'a.json'), '{nope');
    expect(readCachedVerdict(dir, 'a')).toBeUndefined();
    writeFileSync(join(dir, 'b.json'), JSON.stringify(entryFor('other')));
    expect(readCachedVerdict(dir, 'b')).toBeUndefined();
    writeFileSync(join(dir, 'c.json'), 'null');
    expect(readCachedVerdict(dir, 'c')).toBeUndefined();
    writeFileSync(join(dir, 'd.json'), JSON.stringify({ ...entryFor('d'), verdict: null }));
    expect(readCachedVerdict(dir, 'd')).toBeUndefined();
    expect(readCachedVerdict(join(dir, 'missing'), 'a')).toBeUndefined();
  });

  it('does not throw when the parent of the cache dir is a regular file', () => {
    const file = join(dir, 'file');
    writeFileSync(file, 'x');
    expect(() => writeCachedVerdict(join(file, 'sub'), 'k', entryFor('k'))).not.toThrow();
    expect(readFileSync(file, 'utf8')).toBe('x');
  });

  it('treats an unreadable cache directory as a miss and judgeReadiness still returns a verdict', async () => {
    const file = join(dir, 'not-a-dir');
    writeFileSync(file, 'x');
    const run = vi.fn(async (_p: string) => ({ model: 'm', output: JSON.stringify(verdict), cost: 0 }));
    const r = await judgeReadiness({ title: 't', body: 'b', run, cache: { dir: file } });
    expect(r.kind).toBe('verdict');
    expect(run).toHaveBeenCalledTimes(1);
  });
});
