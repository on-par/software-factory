// packages/cli/src/cli/run-lane-land-deferred.test.ts — a land starved by a moving base is deferred, not parked (#3957)

import { join } from 'node:path';

import { getFactoryPaths } from '@on-par/factory-core';
import { decideLandDeferral } from '@on-par/factory-core/internal';
import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LandDeferredError } from './land-pr.js';
import { runLane } from './run-lane.js';

const dirs = createTempDirs();
afterEach(() => dirs.cleanup());

const NOW = Date.parse('2026-11-05T00:00:00Z');
const MSG = 'PR #7 on factory/5-x: base kept moving — synced 3 times and origin/main moved again';

async function lane(prevDeferrals: number, extra: Record<string, unknown> = {}) {
  const dir = dirs.makeSync('lane-land-deferred-');
  const paths = { ...getFactoryPaths(dir), events: join(dir, 'events.ndjson'), stop: join(dir, 'STOP') };
  const events: Array<[string, number | string, string]> = [];
  const released: Array<[number, string]> = [];
  const closeParkedPr = vi.fn(async () => {});
  const octokit = vi.fn();
  const order: string[] = [];
  const recordLandDeferred = vi.fn(async (err: LandDeferredError, issue: number, branch: string) => ({
    ...decideLandDeferral(
      prevDeferrals === 0
        ? undefined
        : {
            issue,
            prNumber: 7,
            branch,
            firstDeferredAt: NOW,
            deferrals: prevDeferrals,
            nextRetryAt: NOW,
            lastMessage: '',
          },
      { issue, prNumber: err.prNumber, branch, message: err.message },
      { now: NOW, maxDeferrals: 3 },
    ),
    maxDeferrals: 3,
  }));
  await runLane('app', [5], '/repo', 'on-par/software-factory', paths, {
    ship: async () => 'factory/5-x',
    waitMerge: async () => {
      throw new LandDeferredError(MSG, 7, 'factory/5-x');
    },
    pathExists: () => false,
    now: () => new Date(NOW),
    emitEvent: (_f, type, issue, msg) => {
      events.push([type, issue, msg]);
    },
    releaseIssue: async (issue, outcome) => {
      released.push([issue, outcome]);
    },
    claimNext: async () => {
      order.push('claimNext');
      return null;
    },
    recordLandDeferred,
    octokit,
    closeParkedPr,
    reapWorktree: async () => {},
    ...extra,
  } as any);
  return { events, released, closeParkedPr, octokit, recordLandDeferred, order };
}

describe('runLane land-deferred (#3957)', () => {
  it('a land-deferred outcome records the deferral, settles done and adds no factory:parked label', async () => {
    const r = await lane(0);
    expect(r.recordLandDeferred).toHaveBeenCalledWith(expect.any(LandDeferredError), 5, 'factory/5-x');
    expect(r.released).toEqual([[5, 'done']]);
    expect(r.events.some(([type]) => type === 'parked' || type === 'ci-failed')).toBe(false);
    const deferred = r.events.find(([type]) => type === 'land-deferred');
    expect(deferred?.[2]).toContain('PR #7 deferred (1/3)');
    expect(deferred?.[2]).toContain('land-only retry at 2026-11-05T00:01:00.000Z');
    expect(r.closeParkedPr).not.toHaveBeenCalled();
    expect(r.octokit).not.toHaveBeenCalled(); // no park comment
  });

  it('a park decision at the cap falls through to the ci-failed park', async () => {
    const r = await lane(3);
    expect(r.released).toEqual([[5, 'parked']]);
    expect(r.events.some(([type]) => type === 'parked')).toBe(true);
    expect(r.closeParkedPr).toHaveBeenCalledWith(5, 'factory/5-x', 'ci-failed');
  });

  it('without recordLandDeferred a moving-base give-up parks ci-failed as before', async () => {
    const r = await lane(0, { recordLandDeferred: undefined });
    expect(r.released).toEqual([[5, 'parked']]);
    expect(r.closeParkedPr).toHaveBeenCalledWith(5, 'factory/5-x', 'ci-failed');
  });

  it('due land-deferred retries run before the next claim and inside each land', async () => {
    const order: string[] = [];
    const retryLandDeferred = vi.fn(async () => {
      order.push('retry');
    });
    const r = await lane(0, {
      retryLandDeferred,
      claimNext: async () => {
        order.push('claimNext');
        return null;
      },
      waitMerge: async () => {
        order.push('land');
      },
    });
    expect(r.events.some(([type]) => type === 'landed')).toBe(false);
    expect(order).toEqual(['retry', 'land', 'retry', 'claimNext']);
  });

  it('a failing land-deferred retry is a warn and never changes lane flow', async () => {
    const r = await lane(0, {
      retryLandDeferred: async () => {
        throw new Error('slot timed out');
      },
      waitMerge: async () => {},
    });
    const warns = r.events.filter(([type]) => type === 'warn').map(([, , m]) => m);
    expect(warns.some((m) => m.includes('land-deferred retry failed: slot timed out'))).toBe(true);
    expect(r.released).toEqual([[5, 'done']]);
  });
});
