import { join } from 'node:path';

import { getFactoryPaths } from '@on-par/factory-core';
import { nextRecheckAt, readAwaitingCi, resolveAwaitingCiCapMs, upsertAwaitingCi } from '@on-par/factory-core/internal';
import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { recheckDueAwaitingCi, type AwaitingCiLaneOps } from './awaiting-ci-recheck.js';
import { AwaitingCiError } from './land-pr.js';
import { runLane } from './run-lane.js';

const dirs = createTempDirs();
afterEach(() => dirs.cleanup());

const MIN = 60_000;
const HOUR = 60 * MIN;

async function awaitingCiLane(capHours?: number) {
  const dir = dirs.makeSync('lane-awaiting-ci-');
  const paths = { ...getFactoryPaths(dir), events: join(dir, 'events.ndjson'), stop: join(dir, 'STOP') };
  const file = join(dir, 'awaiting-ci.json');
  const t0 = Date.parse('2026-10-24T00:00:00Z');
  const clock = { t: t0 };
  const events: Array<[string, number | string, string]> = [];
  const parkedIssues: string[] = [];
  const released: Array<[number, string]> = [];
  const verdicts: Array<'pending' | 'green'> = [];
  const merge = vi.fn(async () => {});
  const recheck = (ops: AwaitingCiLaneOps) =>
    recheckDueAwaitingCi({
      ...ops,
      file,
      now: () => clock.t,
      capMs: resolveAwaitingCiCapMs(capHours === undefined ? {} : { ci: { awaitingCiCapHours: capHours } }),
      getPr: async () => ({ state: 'open', merged: false, headSha: 'abc', baseRef: 'main' }),
      verdict: async () => {
        const state = verdicts.shift() ?? 'pending';
        return { state, missing: [], pending: [], failed: [], total: state === 'green' ? 1 : 0 };
      },
      merge,
    });
  await runLane('app', [5], '/repo', 'on-par/software-factory', paths, {
    ship: async () => 'factory/5-x',
    waitMerge: async () => {
      throw new AwaitingCiError('no CI', 7, 'abc');
    },
    pathExists: () => false,
    now: () => new Date(clock.t),
    emitEvent: (_f, type, issue, msg) => {
      events.push([type, issue, msg]);
      if (type === 'parked') parkedIssues.push(msg);
    },
    releaseIssue: async (issue, outcome) => {
      released.push([issue, outcome]);
    },
    recordAwaitingCi: (rec) => upsertAwaitingCi(file, rec),
    reapWorktree: async () => {},
  });
  return { clock, t0, file, events, parkedIssues, released, verdicts, merge, recheck };
}

describe('runLane awaiting-ci (#3208)', () => {
  it('a PR whose CI never started waits as awaiting-ci and merges when CI arrives late', async () => {
    const lane = await awaitingCiLane();
    expect(lane.parkedIssues).toEqual([]);
    expect(lane.released).toEqual([[5, 'done']]);
    expect(lane.events.some(([type]) => type === 'awaiting-ci')).toBe(true);
    const [rec] = await readAwaitingCi(lane.file);
    expect(rec).toMatchObject({ issue: 5, prNumber: 7, branch: 'factory/5-x', headSha: 'abc', attempts: 0 });
    expect(rec.nextRecheckAt).toBe(lane.t0 + 2 * MIN);
    expect(nextRecheckAt(lane.t0, 3)).toBe(lane.t0 + 45 * MIN);

    const ops: AwaitingCiLaneOps = { park: vi.fn(), emit: () => {} };
    lane.verdicts.push('pending', 'pending', 'green');
    const due: number[] = [];
    for (const offset of [2 * MIN, 5 * MIN, 15 * MIN]) {
      lane.clock.t = lane.t0 + offset;
      await lane.recheck(ops);
      due.push(...(await readAwaitingCi(lane.file)).map((r) => r.nextRecheckAt - lane.t0));
    }
    expect(due).toEqual([5 * MIN, 15 * MIN]);
    expect(lane.merge).toHaveBeenCalledWith(expect.objectContaining({ issue: 5 }), 'abc');
    expect(await readAwaitingCi(lane.file)).toEqual([]);
    expect(ops.park).not.toHaveBeenCalled();
  });

  it.each([
    [undefined, 24],
    [2, 2],
  ])('an awaiting-ci PR with no checks past the cap parks as ci-never-started (cap hours %s)', async (cap, hours) => {
    const lane = await awaitingCiLane(cap);
    const park = vi.fn(async () => {});
    lane.clock.t = lane.t0 + hours * HOUR - MIN;
    await lane.recheck({ park, emit: () => {} });
    expect(park).not.toHaveBeenCalled();
    lane.clock.t = lane.t0 + hours * HOUR + 30 * MIN;
    await lane.recheck({ park, emit: () => {} });
    expect(park).toHaveBeenCalledWith(expect.objectContaining({ issue: 5 }), 'ci-never-started', expect.any(String));
    expect(await readAwaitingCi(lane.file)).toEqual([]);
  });

  it('parks through the lane park path: reason event, parked event, parked release', async () => {
    const dir = dirs.makeSync('lane-awaiting-ci-park-');
    const paths: any = { events: join(dir, 'e.ndjson'), stop: join(dir, 'STOP') };
    const events: string[] = [];
    const released: Array<[number, string]> = [];
    const warnings: string[] = [];
    await runLane('app', [], '/repo', 'on-par/software-factory', paths, {
      pathExists: () => false,
      emitEvent: (_f, type, _i, msg) => {
        events.push(type);
        if (type === 'warn') warnings.push(msg);
      },
      claimNext: async () => null,
      releaseIssue: async (issue, outcome) => {
        released.push([issue, outcome]);
      },
      reapWorktree: async () => {},
      recheckAwaitingCi: async (ops) => {
        await ops.park(
          { issue: 9, prNumber: 3, branch: 'b', headSha: 's', firstSeenAt: 0, attempts: 1, nextRecheckAt: 0 },
          'ci-never-started',
          'no CI ever',
        );
        throw new Error('recheck exploded');
      },
    });
    expect(events).toEqual(expect.arrayContaining(['ci-never-started', 'parked']));
    expect(released).toEqual([[9, 'parked']]);
    expect(warnings.some((w) => w.includes('awaiting-ci recheck failed: recheck exploded'))).toBe(true);
    expect(events.at(-1)).toBe('lane-done');
  });
});
