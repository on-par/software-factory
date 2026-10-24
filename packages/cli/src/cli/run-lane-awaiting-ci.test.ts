// packages/cli/src/cli/run-lane-awaiting-ci.test.ts — runLane's awaiting-ci outcome and its re-check backoff (#3208)

import { join } from 'node:path';

import { resolveAwaitingCiCapMs } from '@on-par/factory-core/internal';
import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type AwaitingCiRecord, readAwaitingCi, recordAwaitingCi, runAwaitingCiRechecks } from './awaiting-ci.js';
import { AwaitingCiError } from './land-pr.js';
import { runLane } from './run-lane.js';

const MIN = 60_000;
const T0 = Date.parse('2026-10-17T00:00:00Z');
const paths: any = { events: '/repo/.factory/events.ndjson', stop: '/repo/.factory/STOP' };

const tmp = createTempDirs();

describe('runLane awaiting-ci', () => {
  let dir: string;
  beforeEach(() => {
    dir = tmp.makeSync('lane-awaiting-ci-');
  });
  afterEach(() => tmp.cleanup());

  it('a PR whose CI never started waits as awaiting-ci and merges when CI arrives late', async () => {
    const events: string[] = [];
    const released: any[] = [];
    const recorded: any[] = [];
    const file = join(dir, 'awaiting-ci.json');
    await runLane('app', [1], '/repo', 'on-par/software-factory', paths, {
      ship: async () => 'ship-it/1-x',
      waitMerge: async () => {
        throw new AwaitingCiError('PR #101 awaiting CI', 101, 'd'.repeat(40));
      },
      recordAwaitingCi: async (r) => {
        recorded.push(r);
        recordAwaitingCi(file, r, T0);
      },
      releaseIssue: async (issue, outcome) => {
        released.push([issue, outcome]);
      },
      pathExists: () => false,
      emitEvent: (_e: string, type: string, _i: any, msg: string) => events.push(`${type}: ${msg}`),
    });
    expect(events.some((e) => e.startsWith('parked') || e.startsWith('escalate'))).toBe(false);
    expect(released).toEqual([[1, 'done']]);
    expect(recorded).toEqual([{ issue: 1, prNumber: 101, headSha: 'd'.repeat(40), branch: 'ship-it/1-x' }]);
    expect(events.at(-1)).toContain('1 awaiting CI');

    let now = T0;
    const verdicts = ['pending', 'pending', 'green'];
    const asked: number[] = [];
    const merged: string[] = [];
    const run = () =>
      runAwaitingCiRechecks({
        file,
        nowMs: () => now,
        capMs: resolveAwaitingCiCapMs({}),
        getPr: async () => ({ state: 'open', merged: false, headSha: 'e'.repeat(40) }),
        verdict: async () => {
          asked.push((now - T0) / MIN);
          return verdicts.shift() as 'pending';
        },
        merge: async (_r: AwaitingCiRecord, sha) => {
          merged.push(sha);
        },
        log: () => {},
      });
    for (const minute of [1, 2, 4, 5, 14, 15]) {
      now = T0 + minute * MIN;
      await run();
    }
    expect(asked).toEqual([2, 5, 15]);
    expect(merged).toEqual(['e'.repeat(40)]);
    expect(readAwaitingCi(file)).toEqual([]);
  });

  it('an awaiting-ci PR with no checks past the cap parks as ci-never-started', async () => {
    expect(resolveAwaitingCiCapMs({})).toBe(24 * 60 * MIN);
    expect(resolveAwaitingCiCapMs({ ci: { awaitingCiCapHours: 2 } })).toBe(2 * 60 * MIN);
    const file = join(dir, 'awaiting-ci.json');
    recordAwaitingCi(file, { issue: 5, prNumber: 50, headSha: 'f'.repeat(40), branch: 'ship-it/5-x' }, T0);
    const results = await runAwaitingCiRechecks({
      file,
      nowMs: () => T0 + 25 * 60 * MIN,
      capMs: resolveAwaitingCiCapMs({}),
      getPr: async () => ({ state: 'open', merged: false, headSha: 'f'.repeat(40) }),
      verdict: async () => 'pending',
      merge: async () => {},
      log: () => {},
    });
    expect(results).toMatchObject([{ action: 'parked', reason: 'ci-never-started' }]);

    const parkEvents: any[] = [];
    const released: any[] = [];
    await runLane('app', [], '/repo', 'on-par/software-factory', paths, {
      recheckAwaitingCi: async () => results,
      releaseIssue: async (issue, outcome) => {
        released.push([issue, outcome]);
      },
      pathExists: () => false,
      emitEvent: (_e: string, type: string, issue: any, _m: string, extra?: any) => {
        if (type === 'parked') parkEvents.push([issue, extra.park.reason]);
      },
    });
    expect(parkEvents).toEqual([[5, 'ci-never-started']]);
    expect(released).toEqual([[5, 'parked']]);
  });

  it('stays fail-closed when recording or re-checking rejects, and counts a re-check merge', async () => {
    const events: string[] = [];
    const emitEvent = (_e: string, type: string, _i: any, msg: string) => events.push(`${type}: ${msg}`);
    await runLane('app', [1], '/repo', 'on-par/software-factory', paths, {
      ship: async () => 'ship-it/1-x',
      waitMerge: async () => {
        throw new AwaitingCiError('PR #101 awaiting CI', 101, 'd'.repeat(40));
      },
      recordAwaitingCi: async () => Promise.reject(new Error('disk full')),
      recheckAwaitingCi: async () => [{ action: 'merged', issue: 9, prNumber: 90 }],
      pathExists: () => false,
      emitEvent,
    });
    expect(events).toContainEqual(expect.stringMatching(/^warn: awaiting-ci record failed: .*disk full/));
    expect(events.at(-1)).toContain('1 merged, 0 awaiting review, 1 awaiting CI');

    const warned: string[] = [];
    await runLane('app', [], '/repo', 'on-par/software-factory', paths, {
      recheckAwaitingCi: async () => Promise.reject(new Error('api down')),
      pathExists: () => false,
      emitEvent: (_e: string, _t: string, _i: any, msg: string) => warned.push(msg),
    });
    expect(warned[0]).toMatch(/awaiting-ci re-check failed: .*api down/);
  });
});
