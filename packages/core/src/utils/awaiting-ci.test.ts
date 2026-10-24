import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  awaitingCiFile,
  clearAwaitingCi,
  nextRecheckAt,
  readAwaitingCi,
  resolveAwaitingCiCapMs,
  upsertAwaitingCi,
  type AwaitingCiRecord,
} from './awaiting-ci.js';

const MIN = 60_000;
const rec = (issue: number, extra: Partial<AwaitingCiRecord> = {}): AwaitingCiRecord => ({
  issue,
  prNumber: issue + 100,
  branch: `factory/${issue}`,
  headSha: 'abc',
  firstSeenAt: 1000,
  attempts: 0,
  nextRecheckAt: 1000 + 2 * MIN,
  ...extra,
});

describe('nextRecheckAt', () => {
  it('follows 2m, 5m, 15m, then every 30m', () => {
    const t = 5000;
    expect([0, 1, 2, 3, 4, 5].map((n) => nextRecheckAt(t, n) - t)).toEqual([
      2 * MIN,
      5 * MIN,
      15 * MIN,
      45 * MIN,
      75 * MIN,
      105 * MIN,
    ]);
  });
});

describe('resolveAwaitingCiCapMs', () => {
  it.each([
    [undefined, 24],
    [0, 24],
    [-1, 24],
    [Number.NaN, 24],
    [2, 2],
  ])('cap %s hours resolves to %s hours', (hours, expected) => {
    expect(resolveAwaitingCiCapMs({ ci: { awaitingCiCapHours: hours } })).toBe(expected * 3_600_000);
  });

  it('defaults to 24 hours without a ci section', () => {
    expect(resolveAwaitingCiCapMs({})).toBe(24 * 3_600_000);
  });
});

describe('awaiting-ci store', () => {
  const dir = () => mkdtempSync(join(tmpdir(), 'awaiting-ci-'));

  it('round-trips, replaces by issue and clears', async () => {
    const file = awaitingCiFile({ state: dir() });
    expect(await readAwaitingCi(file)).toEqual([]);
    await upsertAwaitingCi(file, rec(1));
    await upsertAwaitingCi(file, rec(2));
    await upsertAwaitingCi(file, rec(1, { attempts: 3 }));
    const all = await readAwaitingCi(file);
    expect(all.map((r) => [r.issue, r.attempts])).toEqual([
      [2, 0],
      [1, 3],
    ]);
    await clearAwaitingCi(file, 2);
    expect((await readAwaitingCi(file)).map((r) => r.issue)).toEqual([1]);
    await clearAwaitingCi(file, 99);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toHaveLength(1);
  });

  it('reads a malformed file as empty', async () => {
    const file = join(dir(), 'awaiting-ci.json');
    writeFileSync(file, '{not json');
    expect(await readAwaitingCi(file)).toEqual([]);
    writeFileSync(file, JSON.stringify([{ issue: 1 }, rec(3)]));
    expect((await readAwaitingCi(file)).map((r) => r.issue)).toEqual([3]);
  });
});
