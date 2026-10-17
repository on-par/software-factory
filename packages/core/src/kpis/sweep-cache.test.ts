import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  emptyKpiSweepCache,
  parseKpiSweepCache,
  pruneKpiSweepCache,
  readKpiSweepCache,
  writeKpiSweepCache,
  type CachedPr,
} from './sweep-cache.js';

const PREFIXES = ['factory', 'ship-it'];

function cachedPr(number: number, updatedAt: string): CachedPr {
  return { number, issue: String(number), updatedAt, mergedAt: null, closedAt: null, mergeCommitSha: null };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kpi-sweep-cache-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('kpi sweep cache', () => {
  it('round-trips through write and read, creating the state dir', () => {
    const path = join(dir, 'state', 'kpi-sweep-cache.json');
    const cache = {
      ...emptyKpiSweepCache('o/r', PREFIXES),
      cursor: '2026-10-17T00:00:00Z',
      listEtag: 'W/"abc"',
      lastSweepAt: '2026-10-17T01:00:00.000Z',
      prs: { '1': cachedPr(1, '2026-10-16T00:00:00Z') },
    };
    writeKpiSweepCache(path, cache);
    expect(readKpiSweepCache(path, 'o/r', PREFIXES)).toEqual(cache);
    expect(readdirSync(join(dir, 'state'))).toEqual(['kpi-sweep-cache.json']);
  });

  it('reads a missing file as an empty cache', () => {
    const path = join(dir, 'nope.json');
    expect(readKpiSweepCache(path, 'o/r', PREFIXES)).toEqual(emptyKpiSweepCache('o/r', PREFIXES));
    expect(existsSync(path)).toBe(false);
  });

  it('discards a cache built for another repo, other prefixes, another version, or that is not JSON', () => {
    const empty = emptyKpiSweepCache('o/r', PREFIXES);
    const valid = { ...empty, cursor: 'x', prs: { '1': cachedPr(1, 'x') } };
    expect(parseKpiSweepCache(JSON.stringify(valid), 'o/r', PREFIXES)).toEqual(valid);
    expect(parseKpiSweepCache(JSON.stringify(valid), 'o/other', PREFIXES)).toEqual(
      emptyKpiSweepCache('o/other', PREFIXES),
    );
    expect(parseKpiSweepCache(JSON.stringify(valid), 'o/r', ['sf', ...PREFIXES])).toEqual(
      emptyKpiSweepCache('o/r', ['sf', ...PREFIXES]),
    );
    expect(parseKpiSweepCache(JSON.stringify({ ...valid, version: 0 }), 'o/r', PREFIXES)).toEqual(empty);
    expect(parseKpiSweepCache(JSON.stringify({ ...valid, prs: null }), 'o/r', PREFIXES)).toEqual(empty);
    expect(parseKpiSweepCache('null', 'o/r', PREFIXES)).toEqual(empty);
    expect(parseKpiSweepCache('{oops', 'o/r', PREFIXES)).toEqual(empty);
  });

  it('drops non-string cursor fields', () => {
    const raw = { ...emptyKpiSweepCache('o/r', PREFIXES), cursor: 5, listEtag: {}, lastSweepAt: [] };
    expect(parseKpiSweepCache(JSON.stringify(raw), 'o/r', PREFIXES)).toMatchObject({
      cursor: null,
      listEtag: null,
      lastSweepAt: null,
    });
  });

  it('prunes to the newest-updated PRs past the cap', () => {
    const cache = {
      ...emptyKpiSweepCache('o/r', PREFIXES),
      prs: {
        '1': cachedPr(1, '2026-10-01T00:00:00Z'),
        '2': cachedPr(2, '2026-10-03T00:00:00Z'),
        '3': cachedPr(3, '2026-10-02T00:00:00Z'),
      },
    };
    expect(Object.keys(pruneKpiSweepCache(cache, 2).prs).sort()).toEqual(['2', '3']);
    expect(pruneKpiSweepCache(cache, 3)).toBe(cache);
  });
});
