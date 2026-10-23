import { describe, expect, it, vi } from 'vitest';

import type { QueueClaim } from '@on-par/factory-core/internal';

import { createDiskGuard } from './disk-guard.js';
import type { NotifySummary } from './notify.js';
import { runLane } from './run-lane.js';

const GIB = 1024 ** 3;
const paths = {
  events: '/tmp/e.jsonl',
  stop: '/tmp/none-STOP',
  baseHold: '/tmp/bh',
  worktreeKeeps: '/tmp/wk',
  state: '/tmp/s',
} as never;

function scenario(lowPolls: number, withGuard: boolean) {
  const events: string[] = [];
  const emitEvent = ((_f: string, type: string, issue: number | string, msg: string) =>
    void events.push(`${type}:${issue}:${msg.split(' — ')[0]}`)) as never;
  const notified: NotifySummary[] = [];
  const sleeps: number[] = [];
  const claims: QueueClaim[] = [{ issue: 5, decision: { kind: 'build' } }];
  const claimNext = vi.fn(async () => claims.shift() ?? null);
  const releaseIssue = vi.fn(async () => {});
  const ship = vi.fn(async (issue: number, ..._rest: unknown[]) => `https://example.test/pr/${issue}`);
  let polls = 0;
  const diskGuard = withGuard
    ? createDiskGuard({
        minFreeGb: 10,
        paths: ['/w'],
        retryMs: 7,
        eventsFile: 'e',
        stopFile: '/tmp/none-STOP',
        emitEvent,
        notifier: { notify: (s) => void notified.push(s), settle: async () => {}, parked: 0 },
        alertFile: `/tmp/lane-disk-${String(Math.random())}.json`,
        probe: (path) => ({ path, freeBytes: (polls++ < lowPolls ? 0.1 : 50) * GIB }),
        sleep: async (ms) => void sleeps.push(ms),
        pathExists: () => false,
        now: () => new Date('2026-01-01T00:00:00Z'),
        host: 'h',
      })
    : undefined;
  const run = () =>
    runLane('a', [], '/repo', 'o/r', paths, {
      diskGuard,
      claimNext,
      releaseIssue,
      ship,
      emitEvent,
      pathExists: () => false,
      waitMerge: (async () => ({ merged: true })) as never,
      sleep: async (ms) => void sleeps.push(ms),
    });
  return { run, events, notified, sleeps, claimNext, releaseIssue, ship };
}

describe('runLane disk guard', () => {
  it('holds claims while disk is low, emits one disk_low event and one alert, and does not park', async () => {
    const s = scenario(3, true);
    const claimedAtPoll: number[] = [];
    s.claimNext.mockImplementationOnce(async () => {
      claimedAtPoll.push(s.events.filter((e) => e.startsWith('warn:')).length);
      return { issue: 5, decision: { kind: 'build' } };
    });
    await expect(s.run()).resolves.toBeUndefined();
    expect(s.events.filter((e) => e.startsWith('disk_low:'))).toHaveLength(1);
    expect(s.events.filter((e) => e.startsWith('warn:all:lane') || e.includes('paused'))).toHaveLength(3);
    expect(claimedAtPoll).toEqual([3]);
    expect(s.notified).toHaveLength(1);
    expect(s.releaseIssue).not.toHaveBeenCalledWith(expect.anything(), 'parked');
    expect(s.sleeps.filter((m) => m === 7)).toHaveLength(3);
  });

  it('resumes claiming in the same lane run once free space recovers', async () => {
    const s = scenario(2, true);
    await s.run();
    expect(s.claimNext).toHaveBeenCalled();
    expect(s.ship).toHaveBeenCalledTimes(1);
    expect(s.events.some((e) => e.startsWith('disk_recovered:'))).toBe(true);
  });

  it('with enough space the lane emits the same events and calls as without a disk guard', async () => {
    const a = scenario(0, true);
    const b = scenario(0, false);
    await a.run();
    await b.run();
    expect(a.events).toEqual(b.events);
    expect(a.sleeps).toEqual(b.sleeps);
    expect(a.claimNext).toHaveBeenCalledTimes(b.claimNext.mock.calls.length);
    expect(a.ship.mock.calls.map((c) => c[0])).toEqual(b.ship.mock.calls.map((c) => c[0]));
  });
});
