import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  clearLandDeferred,
  decideLandDeferral,
  dueLandDeferrals,
  landDeferredFile,
  readLandDeferred,
  resolveMaxLandDeferrals,
  upsertLandDeferred,
  type LandDeferredRecord,
} from './land-deferred.js';

const next = { issue: 7, prNumber: 70, branch: 'b7', message: 'base kept moving' };
const rec = (over: Partial<LandDeferredRecord> = {}): LandDeferredRecord => ({
  issue: 7,
  prNumber: 70,
  branch: 'b7',
  firstDeferredAt: 1000,
  deferrals: 1,
  nextRetryAt: 2000,
  lastMessage: 'm',
  ...over,
});
const MIN = 60_000;

describe('decideLandDeferral', () => {
  it('defers with 1, 2, 4 minute backoff (the last value repeats)', () => {
    let prev: LandDeferredRecord | undefined;
    const waits: number[] = [];
    for (let i = 0; i < 4; i++) {
      const d = decideLandDeferral(prev, next, { now: 5000, maxDeferrals: 10 });
      if (d.kind !== 'defer') throw new Error('expected defer');
      waits.push(d.record.nextRetryAt - 5000);
      expect(d.record.deferrals).toBe(i + 1);
      expect(d.record.firstDeferredAt).toBe(5000);
      prev = d.record;
    }
    expect(waits).toEqual([MIN, 2 * MIN, 4 * MIN, 4 * MIN]);
  });

  it('keeps firstDeferredAt and records the latest message', () => {
    const d = decideLandDeferral(rec(), { ...next, message: 'again' }, { now: 9000, maxDeferrals: 3 });
    expect(d).toMatchObject({ kind: 'defer', record: { firstDeferredAt: 1000, deferrals: 2, lastMessage: 'again' } });
  });

  it('parks once the deferral cap is reached', () => {
    expect(decideLandDeferral(rec({ deferrals: 3 }), next, { now: 1, maxDeferrals: 3 })).toEqual({
      kind: 'park',
      deferrals: 3,
      message: 'base kept moving',
    });
    expect(decideLandDeferral(rec({ deferrals: 2 }), next, { now: 1, maxDeferrals: 2 }).kind).toBe('park');
    expect(decideLandDeferral(rec({ deferrals: 2 }), next, { now: 1, maxDeferrals: 5 }).kind).toBe('defer');
  });
});

describe('resolveMaxLandDeferrals', () => {
  it('defaults to 3 and honours merge.maxLandDeferrals', () => {
    expect(resolveMaxLandDeferrals({})).toBe(3);
    expect(resolveMaxLandDeferrals({ merge: {} })).toBe(3);
    expect(resolveMaxLandDeferrals({ merge: { maxLandDeferrals: 5 } })).toBe(5);
    expect(resolveMaxLandDeferrals({ merge: { maxLandDeferrals: 0 } })).toBe(3);
    expect(resolveMaxLandDeferrals({ merge: { maxLandDeferrals: 11 } })).toBe(3);
    expect(resolveMaxLandDeferrals({ merge: { maxLandDeferrals: 2.5 } })).toBe(3);
  });
});

describe('dueLandDeferrals', () => {
  it('orders oldest deferral first and drops records not yet due', () => {
    const all = [
      rec({ issue: 3, firstDeferredAt: 500 }),
      rec({ issue: 1, firstDeferredAt: 900 }),
      rec({ issue: 2, firstDeferredAt: 500 }),
      rec({ issue: 4, firstDeferredAt: 100, nextRetryAt: 99_999 }),
    ];
    expect(dueLandDeferrals(all, 2000).map((r) => r.issue)).toEqual([2, 3, 1]);
  });
});

describe('land-deferred file', () => {
  it('upserts, replaces by issue and clears; a missing or malformed file reads as empty', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'land-deferred-'));
    const file = landDeferredFile({ state: dir });
    expect(file).toBe(join(dir, 'land-deferred.json'));
    expect(await readLandDeferred(file)).toEqual([]);
    await upsertLandDeferred(file, rec({ issue: 1 }));
    await upsertLandDeferred(file, rec({ issue: 2 }));
    await upsertLandDeferred(file, rec({ issue: 1, deferrals: 2 }));
    const all = await readLandDeferred(file);
    expect(all.map((r) => [r.issue, r.deferrals]).sort()).toEqual([
      [1, 2],
      [2, 1],
    ]);
    await clearLandDeferred(file, 1);
    expect((await readLandDeferred(file)).map((r) => r.issue)).toEqual([2]);
    await clearLandDeferred(file, 99);
    expect(JSON.parse(await readFile(file, 'utf8'))).toHaveLength(1);
    await writeFile(file, '{not json', 'utf8');
    expect(await readLandDeferred(file)).toEqual([]);
    await writeFile(file, JSON.stringify([{ issue: 'x' }, rec()]), 'utf8');
    expect(await readLandDeferred(file)).toHaveLength(1);
  });
});
