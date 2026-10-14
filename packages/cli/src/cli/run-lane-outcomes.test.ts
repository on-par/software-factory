// packages/cli/src/cli/run-lane-outcomes.test.ts — runLane tests, moved from cli.test.ts (#2800)

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { getFactoryPaths } from '@on-par/factory-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AwaitingReviewError } from './land-pr.js';
import { IssueDecomposedError, IssueSkippedError, LaneParkError } from './index.js';
import { runLane } from './run-lane.js';

describe('cli', () => {
  const originalFactoryMerge = process.env.FACTORY_MERGE;
  const originalFactoryMergeAdmin = process.env.FACTORY_MERGE_ADMIN;

  beforeEach(() => {
    delete process.env.FACTORY_MERGE;
    delete process.env.FACTORY_MERGE_ADMIN;
  });

  afterEach(() => {
    if (originalFactoryMerge === undefined) {
      delete process.env.FACTORY_MERGE;
    } else {
      process.env.FACTORY_MERGE = originalFactoryMerge;
    }
    if (originalFactoryMergeAdmin === undefined) {
      delete process.env.FACTORY_MERGE_ADMIN;
    } else {
      process.env.FACTORY_MERGE_ADMIN = originalFactoryMergeAdmin;
    }
  });

  describe('runLane', () => {
    const paths: any = { events: '/repo/.factory/events.ndjson', stop: '/repo/.factory/STOP' };
    const buildClaim = (issue: number | undefined) =>
      issue === undefined ? null : { issue, decision: { kind: 'build' as const } };

    it('runs both issues and logs lane-done on the green path', async () => {
      const calls: any[] = [];
      await runLane('app', [1, 2], '/repo', 'on-par/software-factory', paths, {
        ship: async (issue) => {
          calls.push(['ship', issue]);
          return `ship-it/${issue}-x`;
        },
        waitMerge: async (issue) => {
          calls.push(['waitMerge', issue]);
        },
        pathExists: () => false,
        emitEvent: (_events: string, type: string, issue: string | number, msg: string, extra?: any) =>
          calls.push(['event', type, issue, msg, extra]),
      });

      expect(calls.filter((c) => c[0] === 'ship')).toEqual([
        ['ship', 1],
        ['ship', 2],
      ]);
      expect(calls.filter((c) => c[0] === 'waitMerge')).toEqual([
        ['waitMerge', 1],
        ['waitMerge', 2],
      ]);
      expect(calls.some((c) => c[0] === 'event' && c[1] === 'parked')).toBe(false);
      const lastEvent = calls.filter((c) => c[0] === 'event').at(-1);
      expect(lastEvent).toEqual([
        'event',
        'lane-done',
        'app',
        'lane complete (2 merged, 0 awaiting review, 0 skipped, 0 decomposed, 0 parked)',
        { lane: 'app' },
      ]);
    });

    it('continues to the next issue on an AwaitingReviewError instead of parking, and counts outcomes', async () => {
      const calls: any[] = [];
      await runLane('app', [1, 2], '/repo', 'on-par/software-factory', paths, {
        ship: async (issue) => {
          calls.push(['ship', issue]);
          return `ship-it/${issue}-x`;
        },
        waitMerge: async (issue) => {
          calls.push(['waitMerge', issue]);
          if (issue === 1) throw new AwaitingReviewError('PR #101 awaiting review', 101);
        },
        pathExists: () => false,
        emitEvent: (_events: string, type: string, issue: string | number, msg: string, extra?: any) =>
          calls.push(['event', type, issue, msg, extra]),
      });

      expect(calls.filter((c) => c[0] === 'ship')).toEqual([
        ['ship', 1],
        ['ship', 2],
      ]);
      const events = calls.filter((c) => c[0] === 'event');
      expect(events.some((e) => e[1] === 'parked')).toBe(false);
      expect(events.some((e) => e[1] === 'awaiting-review')).toBe(false);
      expect(events.at(-1)).toEqual([
        'event',
        'lane-done',
        'app',
        'lane complete (1 merged, 1 awaiting review, 0 skipped, 0 decomposed, 0 parked)',
        { lane: 'app' },
      ]);
    });

    it('continues to the next issue on an IssueSkippedError instead of parking, and counts it as skipped', async () => {
      const calls: any[] = [];
      await runLane('app', [1, 2], '/repo', 'on-par/software-factory', paths, {
        ship: async (issue) => {
          calls.push(['ship', issue]);
          if (issue === 1) throw new IssueSkippedError('#1 already closed', 'already-closed');
          return `ship-it/${issue}-x`;
        },
        waitMerge: async (issue) => {
          calls.push(['waitMerge', issue]);
        },
        pathExists: () => false,
        emitEvent: (_events: string, type: string, issue: string | number, msg: string, extra?: any) =>
          calls.push(['event', type, issue, msg, extra]),
      });

      expect(calls.filter((c) => c[0] === 'ship')).toEqual([
        ['ship', 1],
        ['ship', 2],
      ]);
      expect(calls.filter((c) => c[0] === 'waitMerge')).toEqual([['waitMerge', 2]]);
      const events = calls.filter((c) => c[0] === 'event');
      expect(events.some((e) => e[1] === 'parked')).toBe(false);
      expect(events.at(-1)).toEqual([
        'event',
        'lane-done',
        'app',
        'lane complete (1 merged, 0 awaiting review, 1 skipped, 0 decomposed, 0 parked)',
        { lane: 'app' },
      ]);
    });

    it('splices the decomposed children in after the current issue and ships them in this same lane run, instead of parking', async () => {
      const calls: any[] = [];
      await runLane('app', [1, 2], '/repo', 'on-par/software-factory', paths, {
        ship: async (issue) => {
          calls.push(['ship', issue]);
          if (issue === 1) throw new IssueDecomposedError('issue #1 decomposed into #10, #11', [10, 11]);
          return `ship-it/${issue}-x`;
        },
        waitMerge: async (issue) => {
          calls.push(['waitMerge', issue]);
        },
        pathExists: () => false,
        emitEvent: (_events: string, type: string, issue: string | number, msg: string, extra?: any) =>
          calls.push(['event', type, issue, msg, extra]),
      });

      expect(calls.filter((c) => c[0] === 'ship')).toEqual([
        ['ship', 1],
        ['ship', 10],
        ['ship', 11],
        ['ship', 2],
      ]);
      expect(calls.filter((c) => c[0] === 'waitMerge')).toEqual([
        ['waitMerge', 10],
        ['waitMerge', 11],
        ['waitMerge', 2],
      ]);
      const events = calls.filter((c) => c[0] === 'event');
      expect(events.some((e) => e[1] === 'parked')).toBe(false);
      expect(events.some((e) => e[1] === 'decompose_filed' && e[2] === 1)).toBe(true);
      expect(events.at(-1)).toEqual([
        'event',
        'lane-done',
        'app',
        'lane complete (3 merged, 0 awaiting review, 0 skipped, 1 decomposed, 0 parked)',
        { lane: 'app' },
      ]);
    });

    it('does not enqueue a decomposed child that is already in the lane list', async () => {
      const calls: any[] = [];
      await runLane('app', [1, 2], '/repo', 'on-par/software-factory', paths, {
        ship: async (issue) => {
          calls.push(['ship', issue]);
          if (issue === 1) throw new IssueDecomposedError('issue #1 decomposed into #2', [2]);
          return `ship-it/${issue}-x`;
        },
        waitMerge: async (issue) => {
          calls.push(['waitMerge', issue]);
        },
        pathExists: () => false,
        emitEvent: (_events: string, type: string, issue: string | number, msg: string, extra?: any) =>
          calls.push(['event', type, issue, msg, extra]),
      });

      expect(calls.filter((c) => c[0] === 'ship')).toEqual([
        ['ship', 1],
        ['ship', 2],
      ]);
      expect(calls.at(-1)).toEqual([
        'event',
        'lane-done',
        'app',
        'lane complete (1 merged, 0 awaiting review, 0 skipped, 1 decomposed, 0 parked)',
        { lane: 'app' },
      ]);
    });

    it('continues to the next issue after parking one, and counts it as parked', async () => {
      const calls: any[] = [];
      await runLane('app', [1, 2], '/repo', 'on-par/software-factory', paths, {
        ship: async (issue) => {
          calls.push(['ship', issue]);
          if (issue === 1) throw new LaneParkError('plan escalated: needs a human decision', 'escalate');
          return `ship-it/${issue}-x`;
        },
        waitMerge: async (issue) => {
          calls.push(['waitMerge', issue]);
        },
        releaseIssue: async (issue, outcome) => {
          calls.push(['release', issue, outcome]);
        },
        pathExists: () => false,
        emitEvent: (_events: string, type: string, issue: string | number, msg: string, extra?: any) =>
          calls.push(['event', type, issue, msg, extra]),
      });

      expect(calls.filter((c) => c[0] === 'ship')).toEqual([
        ['ship', 1],
        ['ship', 2],
      ]);
      expect(calls.filter((c) => c[0] === 'waitMerge')).toEqual([['waitMerge', 2]]);
      expect(calls).toContainEqual(['release', 1, 'parked']);
      expect(calls).toContainEqual(['release', 2, 'done']);
      const events = calls.filter((c) => c[0] === 'event');
      expect(events.some((e) => e[1] === 'parked' && e[2] === 1)).toBe(true);
      expect(events.at(-1)).toEqual([
        'event',
        'lane-done',
        'app',
        'lane complete (1 merged, 0 awaiting review, 0 skipped, 0 decomposed, 1 parked)',
        { lane: 'app' },
      ]);
    });

    it('reports the true remaining count on park via countRemaining and still drains the queue (#1222)', async () => {
      const calls: any[] = [];
      const claims = [buildClaim(21), buildClaim(22)];
      const remaining = [1, 0];
      await runLane('app', [], '/repo', 'on-par/software-factory', paths, {
        claimNext: async () => claims.shift() ?? null,
        countRemaining: async () => remaining.shift() ?? 0,
        ship: async (issue) => {
          calls.push(['ship', issue]);
          if (issue === 21) throw new LaneParkError('plan escalated: needs a human decision', 'escalate');
          return `ship-it/${issue}-x`;
        },
        waitMerge: async () => {},
        releaseIssue: async (issue, outcome) => {
          calls.push(['release', issue, outcome]);
        },
        pathExists: () => false,
        emitEvent: (_events: string, type: string, issue: string | number, msg: string, extra?: any) =>
          calls.push(['event', type, issue, msg, extra]),
      });

      const parkedEvent = calls.find((c) => c[0] === 'event' && c[1] === 'parked' && c[2] === 21);
      expect(parkedEvent?.[3]).toContain('1 issue(s) remaining');
      expect(calls.filter((c) => c[0] === 'ship')).toEqual([
        ['ship', 21],
        ['ship', 22],
      ]);
      expect(calls).toContainEqual(['release', 21, 'parked']);
      expect(calls).toContainEqual(['release', 22, 'done']);
    });

    it('falls back to the local count when the countRemaining lookup fails, without changing lane flow (#1222)', async () => {
      const calls: any[] = [];
      const claims = [buildClaim(21), buildClaim(22)];
      await runLane('app', [], '/repo', 'on-par/software-factory', paths, {
        claimNext: async () => claims.shift() ?? null,
        countRemaining: async () => {
          throw new Error('queue list failed');
        },
        ship: async (issue) => {
          calls.push(['ship', issue]);
          if (issue === 21) throw new LaneParkError('plan escalated: needs a human decision', 'escalate');
          return `ship-it/${issue}-x`;
        },
        waitMerge: async () => {},
        releaseIssue: async (issue, outcome) => {
          calls.push(['release', issue, outcome]);
        },
        pathExists: () => false,
        emitEvent: (_events: string, type: string, issue: string | number, msg: string, extra?: any) =>
          calls.push(['event', type, issue, msg, extra]),
      });

      const parkedEvent = calls.find((c) => c[0] === 'event' && c[1] === 'parked' && c[2] === 21);
      expect(parkedEvent?.[3]).toContain('0 issue(s) remaining');
      expect(calls.filter((c) => c[0] === 'ship')).toEqual([
        ['ship', 21],
        ['ship', 22],
      ]);
      expect(calls).toContainEqual(['release', 22, 'done']);
    });

    it('threads ship options plus the run repoRoot, resolved paths, ghRepo, and lane into ship', async () => {
      const seen: any[] = [];
      await runLane('app', [1, 2], '/repo', 'on-par/software-factory', paths, {
        ship: async (_issue, opts, ctx) => {
          seen.push({ opts, ctx });
          return 'ship-it/x';
        },
        waitMerge: async () => {},
        pathExists: () => false,
        emitEvent: () => {},
      });
      expect(seen).toEqual([
        {
          opts: {},
          ctx: {
            repoRoot: '/repo',
            ghRepo: 'on-par/software-factory',
            paths,
            lane: 'app',
            onOutcome: expect.any(Function),
          },
        },
        {
          opts: {},
          ctx: {
            repoRoot: '/repo',
            ghRepo: 'on-par/software-factory',
            paths,
            lane: 'app',
            onOutcome: expect.any(Function),
          },
        },
      ]);
    });

    it('keeps daemon state artifacts in the supplied external state root', async () => {
      const tempRoot = await mkdtemp(join(tmpdir(), 'cli-daemon-state-test-'));
      const repoRoot = join(tempRoot, 'checkout');
      const stateRoot = join(tempRoot, 'daemon-state');
      const daemonPaths = getFactoryPaths(repoRoot, stateRoot);
      const artifacts = (receivedPaths: typeof daemonPaths) => [
        receivedPaths.queue,
        receivedPaths.config,
        receivedPaths.events,
        receivedPaths.costs,
        join(receivedPaths.plans, 'issue-1.md'),
        join(receivedPaths.reports, 'issue-1.md'),
        receivedPaths.breaker,
        receivedPaths.mergeLock,
        receivedPaths.gitLock,
        receivedPaths.runLock,
        receivedPaths.portsLock,
      ];

      try {
        await runLane('daemon', [1], repoRoot, 'on-par/software-factory', daemonPaths, {
          ship: async (_issue, _opts, ctx) => {
            if (!ctx) throw new Error('runLane did not provide a ship context');
            for (const artifact of artifacts(ctx.paths)) {
              await mkdir(dirname(artifact), { recursive: true });
              await writeFile(artifact, 'external state');
            }
            return 'ship-it/1-external-state';
          },
          waitMerge: async () => {},
          pathExists: () => false,
          emitEvent: () => {},
        });

        for (const artifact of artifacts(daemonPaths)) {
          expect(existsSync(artifact)).toBe(true);
          expect(artifact.startsWith(stateRoot)).toBe(true);
        }
        expect(existsSync(join(repoRoot, '.factory'))).toBe(false);
      } finally {
        await rm(tempRoot, { recursive: true, force: true });
      }
    });
  });
});
