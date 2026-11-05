// packages/cli/src/cli/land-deferred-retry.test.ts — land-only retries of land-deferred PRs (#3957)

import { join } from 'node:path';

import { createTempDirs } from '@on-par/factory-core/testing';
import { readLandDeferred, upsertLandDeferred, type LandDeferredRecord } from '@on-par/factory-core/internal';
import { afterEach, describe, expect, it, vi } from 'vitest';

import './index.js';
import { waitForMerge } from './land.js';
import { retryDueLandDeferred, type LandDeferredRetryDeps } from './land-deferred-retry.js';
import {
  AwaitingReviewError,
  CiFailedError,
  LandDeferredError,
  landOpenPullRequest,
  MergeGatedError,
} from './land-pr.js';
import { withLandingSlot } from './land-slot.js';

const dirs = createTempDirs();
afterEach(() => dirs.cleanup());

const MIN = 60_000;
const NOW = 10_000_000;
const rec = (issue: number, over: Partial<LandDeferredRecord> = {}): LandDeferredRecord => ({
  issue,
  prNumber: issue * 10,
  branch: `factory/${issue}-x`,
  firstDeferredAt: NOW - 100 * MIN + issue,
  deferrals: 1,
  nextRetryAt: NOW - MIN,
  lastMessage: 'base kept moving',
  ...over,
});
const moved = (r: LandDeferredRecord) =>
  new LandDeferredError(`PR #${r.prNumber} on ${r.branch}: base kept moving`, r.prNumber, r.branch);

async function setup(records: LandDeferredRecord[], land: (r: LandDeferredRecord) => Promise<void>, max = 3) {
  const dir = dirs.makeSync('land-deferred-retry-');
  const file = join(dir, 'land-deferred.json');
  for (const r of records) await upsertLandDeferred(file, r);
  const events: string[] = [];
  const parks: Array<[number, string, string]> = [];
  const slots: string[] = [];
  const deps: LandDeferredRetryDeps = {
    file,
    now: () => NOW,
    maxDeferrals: max,
    emit: (kind, issue, msg) => events.push(`${kind}:${issue}:${msg}`),
    park: async (r, reason, msg) => {
      parks.push([r.issue, reason, msg]);
    },
    withSlot: async (fn) => {
      slots.push('enter');
      try {
        return await fn();
      } finally {
        slots.push('exit');
      }
    },
    land,
  };
  return { file, deps, events, parks, slots };
}

describe('retryDueLandDeferred (#3957)', () => {
  it('a due retry lands with syncMain and holdsLandingSlot and clears the record without shipping', async () => {
    const dir = dirs.makeSync('land-deferred-wfm-');
    const paths: any = { config: join(dir, 'config.yaml'), events: join(dir, 'e.ndjson'), stop: join(dir, 'STOP') };
    const land = vi.fn(async () => ({ branch: 'factory/5-x', prNumber: 50 }));
    const real = (r: LandDeferredRecord) =>
      waitForMerge(r.issue, r.branch, '/repo', 'o/r', paths, {
        landBranch: r.branch,
        syncMain: true,
        holdsLandingSlot: true,
        holdWhenGated: true,
        createOctokit: () => ({}) as any,
        pathExists: () => false,
        checkMerged: async () => false,
        loadConfig: () =>
          ({
            filing: {
              enabled: true,
              excludeReasons: [],
              repeatThreshold: 3,
              maxPerRun: 5,
              maxPerDay: 20,
              selfFixLabel: 'no-auto-merge',
              bugLabels: ['bug'],
              sensitivePaths: [],
            },
          }) as any,
        mergeEnabled: () => true,
        listIssueLabels: async () => [],
        emitEvent: () => {},
        land,
      });
    const { file, deps, events } = await setup([rec(5)], real);
    await retryDueLandDeferred(deps);
    expect(land).toHaveBeenCalledTimes(1);
    expect(land.mock.calls[0]).toEqual([
      5,
      '/repo',
      'o/r',
      paths,
      expect.anything(),
      expect.anything(),
      undefined,
      expect.objectContaining({
        branch: 'factory/5-x',
        syncMain: true,
        holdsLandingSlot: true,
        enforceRisk: true,
      }),
    ]);
    expect(await readLandDeferred(file)).toEqual([]);
    expect(events).toEqual([
      'land-deferred:5:retrying PR #50 (deferral 1/3), land only',
      'landed:5:PR #50 landed on a land-only retry',
    ]);
  });

  it('two due records retry oldest deferral first, one slot hold each', async () => {
    const order: number[] = [];
    const { deps, file, slots } = await setup(
      [rec(2, { firstDeferredAt: NOW - 10 * MIN }), rec(1, { firstDeferredAt: NOW - 50 * MIN })],
      async (r) => {
        order.push(r.issue);
      },
    );
    await retryDueLandDeferred(deps);
    expect(order).toEqual([1, 2]);
    expect(await readLandDeferred(file)).toEqual([]);
    expect(slots).toEqual(['enter', 'exit', 'enter', 'exit', 'enter', 'exit']); // the last pass finds nothing
  });

  it('a record not yet due is left alone', async () => {
    const land = vi.fn(async () => {});
    const { deps, file } = await setup([rec(3, { nextRetryAt: NOW + MIN })], land);
    await retryDueLandDeferred(deps);
    expect(land).not.toHaveBeenCalled();
    expect(await readLandDeferred(file)).toHaveLength(1);
  });

  it('a retry that gives up again reschedules with backoff and bumps the count', async () => {
    const { deps, file, events, parks } = await setup([rec(4, { deferrals: 1 })], async (r) => {
      throw moved(r);
    });
    await retryDueLandDeferred(deps);
    const [next] = await readLandDeferred(file);
    expect(next).toMatchObject({ issue: 4, deferrals: 2, nextRetryAt: NOW + 2 * MIN });
    expect(parks).toEqual([]);
    expect(events.at(-1)).toContain('deferral 2/3');
  });

  it('a retry that gives up again past the cap parks ci-failed with the base kept moving reason', async () => {
    const { deps, file, parks } = await setup([rec(4, { deferrals: 3 })], async (r) => {
      throw moved(r);
    });
    await retryDueLandDeferred(deps);
    expect(parks).toEqual([[4, 'ci-failed', 'PR #40 on factory/4-x: base kept moving']]);
    expect(await readLandDeferred(file)).toEqual([]);
  });

  it('a retry whose CI fails parks ci-failed', async () => {
    const { deps, file, parks } = await setup([rec(6)], async (r) => {
      throw new CiFailedError('CI failed', r.prNumber);
    });
    await retryDueLandDeferred(deps);
    expect(parks).toEqual([[6, 'ci-failed', 'CI failed']]);
    expect(await readLandDeferred(file)).toEqual([]);
  });

  it('review and gate holds clear the record without parking', async () => {
    const errs = [
      new AwaitingReviewError('needs review', 10, 'risk'),
      new MergeGatedError('gated', 20, 200, 'factory:self-fix'),
    ];
    const { deps, events, parks, file } = await setup([rec(1), rec(2)], async (r) => {
      throw errs[r.issue - 1];
    });
    await retryDueLandDeferred(deps);
    expect(parks).toEqual([]);
    expect(events).toContain('awaiting-review:1:needs review');
    expect(events).toContain('merge-gated:2:gated');
    expect(await readLandDeferred(file)).toEqual([]);
  });

  it('any other failure parks with its reason and a slot timeout ends the drain with a warn', async () => {
    const a = await setup([rec(7)], async () => {
      throw new Error('boom');
    });
    await retryDueLandDeferred(a.deps);
    expect(a.parks).toHaveLength(1);
    expect(a.parks[0][0]).toBe(7);

    const b = await setup([rec(8)], async () => {});
    await retryDueLandDeferred({
      ...b.deps,
      withSlot: async () => {
        throw new Error('slot timed out');
      },
    });
    expect(b.events.at(-1)).toMatch(/^warn:0:land-deferred retry failed: .*slot timed out/);
    expect(await readLandDeferred(b.file)).toHaveLength(1);
  });

  it('holds the real landing slot for the whole land', async () => {
    const dir = dirs.makeSync('land-deferred-slot-');
    const slotPaths = { landSlotLock: join(dir, 'land-slot.lock') };
    const { deps } = await setup([rec(9)], async () => {
      await expect(withLandingSlot(slotPaths, async () => 'x', { timeoutMs: 0 })).rejects.toThrow();
    });
    await retryDueLandDeferred({ ...deps, withSlot: (fn) => withLandingSlot(slotPaths, fn) });
  });

  it('a deferred retry merges pinned to the CI-verified head sha', async () => {
    const merges: string[] = [];
    const octokit: any = {
      graphql: async () => ({
        repository: { pullRequest: { id: 'PR_1', isDraft: false, mergeStateStatus: 'CLEAN' } },
      }),
      rest: {
        pulls: {
          get: async () => ({ data: { head: { sha: 'verified-sha' }, base: { ref: 'main' } } }),
          merge: async (args: { sha: string }) => {
            merges.push(args.sha);
          },
        },
        repos: { compareCommitsWithBasehead: async () => ({ data: { behind_by: 0 } }) },
        git: { deleteRef: async () => {} },
      },
    };
    const run = async (command: string) => {
      if (command === 'git status --porcelain -z') return { stdout: '' };
      if (command.startsWith('git rev-parse --git-path')) return { stdout: '.git/operation' };
      if (command.startsWith('test -e')) return { stdout: 'no' };
      if (command === 'git rev-parse --verify HEAD' || command.startsWith('git merge-base'))
        return { stdout: 'a'.repeat(40) };
      return { stdout: '' };
    };
    await landOpenPullRequest({
      octokit,
      owner: 'o',
      repoName: 'r',
      ghRepo: 'o/r',
      repoRoot: '/repo',
      issue: 5,
      branch: 'factory/5-x',
      worktree: '/repo-5',
      prNumber: 50,
      syncMain: true,
      log: () => {},
      run,
      pathExists: () => true,
      sleep: async () => {},
      adminMerge: false,
      watch: (async () => 'success') as any,
      withLock: (fn) => fn(),
    });
    expect(merges).toEqual(['verified-sha']);
  });
});
