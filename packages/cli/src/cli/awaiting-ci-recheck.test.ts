import { join } from 'node:path';
import { type AwaitingCiRecord, readAwaitingCi, upsertAwaitingCi } from '@on-par/factory-core/internal';
import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { recheckDueAwaitingCi, type AwaitingCiRecheckDeps } from './awaiting-ci-recheck.js';

const dirs = createTempDirs();
afterEach(() => dirs.cleanup());

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = 1_000_000;

const record = (issue: number, extra: Partial<AwaitingCiRecord> = {}): AwaitingCiRecord => ({
  issue,
  prNumber: issue + 100,
  branch: `factory/${issue}`,
  headSha: 'old-sha',
  firstSeenAt: T0,
  attempts: 0,
  nextRecheckAt: T0 + 2 * MIN,
  ...extra,
});

async function harness(overrides: Partial<AwaitingCiRecheckDeps> = {}, records: AwaitingCiRecord[] = [record(1)]) {
  const file = join(dirs.makeSync('recheck-'), 'awaiting-ci.json');
  for (const rec of records) await upsertAwaitingCi(file, rec);
  const clock = { t: T0 };
  const events: Array<[string, number, string]> = [];
  const deps: AwaitingCiRecheckDeps = {
    file,
    now: () => clock.t,
    capMs: 24 * HOUR,
    getPr: async () => ({ state: 'open', merged: false, headSha: 'new-sha', baseRef: 'main' }),
    verdict: async () => ({ state: 'pending', missing: [], pending: [], failed: [], total: 0 }),
    merge: vi.fn(async () => {}),
    park: vi.fn(async () => {}),
    emit: (kind, issue, msg) => events.push([kind, issue, msg]),
    ...overrides,
  };
  return { deps, clock, events, run: () => recheckDueAwaitingCi(deps), read: () => readAwaitingCi(file) };
}

describe('recheckDueAwaitingCi (#3208)', () => {
  it('does nothing before a record is due', async () => {
    const h = await harness();
    h.clock.t = T0 + MIN;
    await h.run();
    expect(h.events).toEqual([]);
    expect((await h.read())[0].attempts).toBe(0);
  });

  it('merges pinned to the head SHA and clears the record when verify goes green 3 hours later', async () => {
    const h = await harness({
      verdict: async () => ({ state: 'green', missing: [], pending: [], failed: [], total: 1 }),
    });
    h.clock.t = T0 + 3 * HOUR;
    await h.run();
    expect(h.deps.merge).toHaveBeenCalledWith(expect.objectContaining({ issue: 1, branch: 'factory/1' }), 'new-sha');
    expect(await h.read()).toEqual([]);
    expect(h.deps.park).not.toHaveBeenCalled();
    expect(h.events.map((e) => e[0])).toEqual(['ship']);
  });

  it('parks ci-failed and clears the record on a failed verdict', async () => {
    const h = await harness({
      verdict: async () => ({ state: 'failed', missing: [], pending: [], failed: ['lint'], total: 2 }),
    });
    h.clock.t = T0 + 3 * MIN;
    await h.run();
    expect(h.deps.park).toHaveBeenCalledWith(
      expect.objectContaining({ issue: 1 }),
      'ci-failed',
      expect.stringContaining('lint'),
    );
    expect(await h.read()).toEqual([]);
  });

  it('reschedules a pending record with the next backoff slot and the current head SHA', async () => {
    const h = await harness();
    h.clock.t = T0 + 2 * MIN;
    await h.run();
    expect(await h.read()).toEqual([
      expect.objectContaining({ attempts: 1, nextRecheckAt: T0 + 5 * MIN, headSha: 'new-sha' }),
    ]);
    expect(h.events[0][0]).toBe('awaiting-ci');
    expect(h.deps.park).not.toHaveBeenCalled();
  });

  it('parks ci-never-started past the cap when no check run ever registered', async () => {
    const h = await harness();
    h.clock.t = T0 + 24 * HOUR;
    await h.run();
    expect(h.deps.park).toHaveBeenCalledWith(
      expect.objectContaining({ issue: 1 }),
      'ci-never-started',
      'PR #101 head new-sha: no CI run ever registered after 24 h — a CI or config problem, not a failing build',
    );
    expect(await h.read()).toEqual([]);
  });

  it('parks ci-failed past the cap when runs exist but are still pending', async () => {
    const h = await harness({
      verdict: async () => ({ state: 'pending', missing: [], pending: ['verify'], failed: [], total: 1 }),
    });
    h.clock.t = T0 + 25 * HOUR;
    await h.run();
    expect(h.deps.park).toHaveBeenCalledWith(
      expect.anything(),
      'ci-failed',
      expect.stringContaining('CI still pending after 25 h'),
    );
  });

  it.each([
    [true, 'merged'],
    [false, 'closed'],
  ])('clears the record of a PR closed out of band (merged: %s) without merging or parking', async (merged, word) => {
    const h = await harness({ getPr: async () => ({ state: 'closed', merged, headSha: 'x', baseRef: 'main' }) });
    h.clock.t = T0 + 3 * MIN;
    await h.run();
    expect(await h.read()).toEqual([]);
    expect(h.events[0][2]).toContain(word);
    expect(h.deps.merge).not.toHaveBeenCalled();
    expect(h.deps.park).not.toHaveBeenCalled();
  });

  it('reschedules instead of merging when the pinned merge is refused because the head moved', async () => {
    const h = await harness({
      verdict: async () => ({ state: 'green', missing: [], pending: [], failed: [], total: 1 }),
      merge: vi.fn(async () => {
        throw new Error('Head branch was modified');
      }),
    });
    h.clock.t = T0 + 3 * MIN;
    await h.run();
    expect((await h.read())[0]).toMatchObject({ attempts: 1, nextRecheckAt: T0 + 5 * MIN });
    expect(h.events.map((e) => e[0])).toEqual(['warn', 'awaiting-ci']);
  });

  it("one record's error does not stop the others and keeps its record", async () => {
    const h = await harness(
      {
        getPr: async (n) => {
          if (n === 101) throw new Error('boom');
          return { state: 'closed', merged: true, headSha: 'x', baseRef: 'main' };
        },
      },
      [record(1), record(2)],
    );
    h.clock.t = T0 + 3 * MIN;
    await h.run();
    expect((await h.read()).map((r) => r.issue)).toEqual([1]);
    expect(h.events.find((e) => e[0] === 'warn')?.[2]).toContain('PR #101 failed: boom');
  });
});
