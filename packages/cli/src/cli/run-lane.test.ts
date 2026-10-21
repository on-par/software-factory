// packages/cli/src/cli/run-lane.test.ts — runLane tests, moved from cli.test.ts (#2800)

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AwaitingReviewError, LandConflictError } from './land-pr.js';
import { LaneParkError } from './index.js';
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

    describe('stack restack (#3368)', () => {
      const parkedOutcome = {
        status: 'park' as const,
        reason: 'restack of slice 2/3 PR #12 onto origin/main conflicted in: a.ts; nothing was pushed',
        index: 2,
        prNumber: 12,
        files: ['a.ts'],
      };
      const restackedOutcome = {
        status: 'restacked' as const,
        plan: { issue: 7, slices: [] },
        slices: [{ index: 2, prNumber: 12, branch: 'factory/7-slice-2', headSha: 'abc' }],
        retargeted: true,
      };
      const run = async (claims: any[], restack: any, extra: any = {}) => {
        const calls: any[] = [];
        await runLane('app', [], '/repo', 'on-par/software-factory', paths, {
          claimNext: async () => claims.shift() ?? null,
          ship: async () => {
            calls.push(['ship']);
            return 'b';
          },
          waitMerge: async () => {},
          restack: async (issue: number, merged: any) => {
            calls.push(['restack', issue, merged]);
            return restack();
          },
          releaseIssue: async (issue, outcome) => {
            calls.push(['release', issue, outcome]);
          },
          pathExists: () => false,
          emitEvent: (_f: any, type: any, _i: any, msg: any) => calls.push(['event', type, msg]),
          ...extra,
        });
        return calls;
      };
      const restackClaim = () => [
        { issue: 7, decision: { kind: 'restack' as const, mergedIndex: 1, mergedPrNumber: 11 } },
      ];

      it('runs the restack for a restack decision and re-queues the issue', async () => {
        const calls = await run(restackClaim(), () => restackedOutcome);
        expect(calls).toContainEqual(['restack', 7, { index: 1, prNumber: 11 }]);
        expect(calls).toContainEqual(['release', 7, 'queued']);
        expect(calls.some((c) => c[0] === 'ship')).toBe(false);
      });

      it('re-queues on a nothing outcome', async () => {
        const calls = await run(restackClaim(), () => ({ status: 'nothing', reason: 'already restacked' }));
        expect(calls).toContainEqual(['release', 7, 'queued']);
      });

      it('parks with the restack reason and does not ship', async () => {
        const calls = await run(restackClaim(), () => parkedOutcome);
        expect(calls).toContainEqual(['release', 7, 'parked']);
        expect(calls.some((c) => c[0] === 'event' && c[1] === 'escalate' && c[2] === parkedOutcome.reason)).toBe(true);
        expect(calls.some((c) => c[0] === 'ship')).toBe(false);
      });

      it('parks when the restack throws', async () => {
        const calls = await run(restackClaim(), () => {
          throw new Error('boom');
        });
        expect(calls).toContainEqual(['release', 7, 'parked']);
        expect(
          calls.some((c) => c[0] === 'event' && c[1] === 'escalate' && String(c[2]).includes('restack failed')),
        ).toBe(true);
      });

      const layerClaim = (index: number) => [
        {
          issue: 7,
          decision: {
            kind: 'adopt' as const,
            branch: `factory/7-slice-${index}`,
            stackLayer: { index, count: 3, prNumber: 10 + index },
          },
        },
      ];

      it('restacks after a non-top stack layer merges', async () => {
        const calls = await run(layerClaim(1), () => restackedOutcome);
        expect(calls).toContainEqual(['restack', 7, { index: 1, prNumber: 11 }]);
        expect(calls).toContainEqual(['release', 7, 'queued']);
      });

      it('parks instead of re-queuing when the post-merge restack parks', async () => {
        const calls = await run(layerClaim(1), () => parkedOutcome);
        expect(calls).toContainEqual(['release', 7, 'parked']);
        expect(calls).not.toContainEqual(['release', 7, 'queued']);
      });

      it('does not restack after the top stack layer merges', async () => {
        const calls = await run(layerClaim(3), () => restackedOutcome);
        expect(calls.some((c) => c[0] === 'restack')).toBe(false);
        expect(calls).toContainEqual(['release', 7, 'done']);
      });
    });

    it('lands an adopted claim through its real branch without calling shipIssue', async () => {
      const calls: any[] = [];
      const claims = [{ issue: 7, decision: { kind: 'adopt' as const, branch: 'contributor/real-head' } }];
      await runLane('app', [], '/repo', 'on-par/software-factory', paths, {
        claimNext: async () => claims.shift() ?? null,
        ship: async () => {
          throw new Error('shipIssue must not run for an adopted PR');
        },
        waitMerge: async (issue, branch) => {
          calls.push(['waitMerge', issue, branch]);
        },
        releaseIssue: async (issue, outcome) => {
          calls.push(['release', issue, outcome]);
        },
        pathExists: () => false,
        emitEvent: () => {},
      });

      expect(calls).toEqual([
        ['waitMerge', 7, 'contributor/real-head'],
        ['release', 7, 'done'],
      ]);
    });

    it.each([
      [2, 'queued', false],
      [3, 'done', true],
    ] as const)(
      'slice %i/3 ready outcome releases as %s (waitMerge called: %s) (ADR-0147)',
      async (index, released, waits) => {
        const calls: any[] = [];
        const claims = [buildClaim(5)!];
        await runLane('app', [], '/repo', 'on-par/software-factory', paths, {
          claimNext: async () => claims.shift() ?? null,
          ship: async (_issue, _opts, ctx) => {
            ctx?.onOutcome?.({
              state: 'ready',
              route: 'codex',
              branch: 'b',
              reworkRounds: 0,
              prNumber: 55,
              slice: { index, count: 3 },
            });
            return 'b';
          },
          waitMerge: async (issue) => {
            calls.push(['waitMerge', issue]);
          },
          releaseIssue: async (issue, outcome) => {
            calls.push(['release', issue, outcome]);
          },
          pathExists: () => false,
          emitEvent: () => {},
        });

        expect(calls).toEqual(
          waits
            ? [
                ['waitMerge', 5],
                ['release', 5, released],
              ]
            : [['release', 5, released]],
        );
      },
    );

    it('stack-wait released outcome settles queued without waitMerge (#3367)', async () => {
      const calls: any[] = [];
      const claims = [buildClaim(5)!];
      await runLane('app', [], '/repo', 'on-par/software-factory', paths, {
        claimNext: async () => claims.shift() ?? null,
        ship: async (_issue, _opts, ctx) => {
          ctx?.onOutcome?.({
            state: 'released',
            reason: 'stack-wait',
            branch: 'b',
            reworkRounds: 0,
            prNumber: 55,
            slice: { index: 1, count: 3 },
          });
          return 'b';
        },
        waitMerge: async (issue) => {
          calls.push(['waitMerge', issue]);
        },
        releaseIssue: async (issue, outcome) => {
          calls.push(['release', issue, outcome]);
        },
        pathExists: () => false,
        emitEvent: () => {},
      });

      expect(calls).toEqual([['release', 5, 'queued']]);
    });

    it('heartbeats the claim lease every 5 minutes while ship/waitMerge are in flight, and stops once they settle (#1500)', async () => {
      vi.useFakeTimers();
      try {
        const heartbeats: number[] = [];
        let resolveShip!: () => void;
        const shipGate = new Promise<void>((resolve) => {
          resolveShip = resolve;
        });

        const runPromise = runLane('app', [9], '/repo', 'on-par/software-factory', paths, {
          ship: async (issue) => {
            await shipGate;
            return `ship-it/${issue}-x`;
          },
          waitMerge: async () => {},
          releaseIssue: async () => {},
          heartbeat: async (issue) => {
            heartbeats.push(issue);
          },
          pathExists: () => false,
          emitEvent: () => {},
        });

        await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
        await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
        expect(heartbeats).toEqual([9, 9]);

        resolveShip();
        await runPromise;

        // No further heartbeats fire once ship/waitMerge have both settled.
        await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
        expect(heartbeats).toEqual([9, 9]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('parks a preflight claim without invoking shipIssue and leaves another lane independent', async () => {
      const parked: any[] = [];
      const finished: any[] = [];
      let claimed = false;
      await Promise.allSettled([
        runLane('parked', [], '/repo', 'on-par/software-factory', paths, {
          claimNext: async () => {
            if (claimed) return null;
            claimed = true;
            return { issue: 7, decision: { kind: 'park' as const, reason: 'CI for PR #71 ended timeout' } };
          },
          ship: async () => {
            throw new Error('shipIssue must not run for a parked preflight');
          },
          releaseIssue: async (issue, outcome) => {
            parked.push(['release', issue, outcome]);
          },
          pathExists: () => false,
          emitEvent: (_events, type) => parked.push(['event', type]),
        }),
        runLane('healthy', [8], '/repo', 'on-par/software-factory', paths, {
          ship: async () => 'ship-it/8-healthy',
          waitMerge: async () => {
            finished.push('merged');
          },
          pathExists: () => false,
          emitEvent: () => {},
        }),
      ]);

      expect(parked).toContainEqual(['release', 7, 'parked']);
      expect(finished).toEqual(['merged']);
    });

    it('parks issue 7 and continues the lane to issue 8 without re-emitting the terminal event (shipIssue owns it) on an escalate error', async () => {
      const calls: any[] = [];
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await runLane('app', [7, 8], '/repo', 'on-par/software-factory', paths, {
        ship: async (issue) => {
          calls.push(['ship', issue]);
          if (issue === 7) throw new LaneParkError('plan escalated: needs a human decision', 'escalate');
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
        ['ship', 7],
        ['ship', 8],
      ]);
      const events = calls.filter((c) => c[0] === 'event');
      expect(events[0][1]).toBe('parked');
      expect(events[0][2]).toBe(7);
      expect(events[0][3]).toContain('(escalate)');
      expect(events[0][4]).toEqual({ lane: 'app' });
      expect(events.some((e) => e[1] === 'escalate')).toBe(false);
      expect(events.at(-1)).toEqual([
        'event',
        'lane-done',
        'app',
        'lane complete (1 merged, 0 awaiting review, 0 skipped, 0 decomposed, 1 parked)',
        { lane: 'app' },
      ]);
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it('parks the lane without re-emitting the terminal event (shipIssue owns it) on a timeout error', async () => {
      const calls: any[] = [];
      await runLane('app', [9], '/repo', 'on-par/software-factory', paths, {
        ship: async () => {
          throw Object.assign(new Error('router exhausted'), { reason: 'timeout' });
        },
        waitMerge: async () => {
          throw new Error('waitMerge should not be called');
        },
        pathExists: () => false,
        emitEvent: (_events: string, type: string, issue: string | number, msg: string, extra?: any) =>
          calls.push(['event', type, issue, msg, extra]),
      });

      const events = calls.filter((c) => c[0] === 'event');
      expect(events).toHaveLength(2);
      expect(events[0][1]).toBe('parked');
      expect(events[0][2]).toBe(9);
      expect(events[0][3]).toContain('(timeout)');
      expect(events.some((e) => e[1] === 'timeout')).toBe(false);
      expect(events.at(-1)).toEqual([
        'event',
        'lane-done',
        'app',
        'lane complete (0 merged, 0 awaiting review, 0 skipped, 0 decomposed, 1 parked)',
        { lane: 'app' },
      ]);
    });

    it('parks the lane without re-emitting the terminal event (shipIssue owns it) on a plain fail error', async () => {
      const calls: any[] = [];
      await runLane('app', [10], '/repo', 'on-par/software-factory', paths, {
        ship: async () => {
          throw new Error('boom');
        },
        waitMerge: async () => {
          throw new Error('waitMerge should not be called');
        },
        pathExists: () => false,
        emitEvent: (_events: string, type: string, issue: string | number, msg: string, extra?: any) =>
          calls.push(['event', type, issue, msg, extra]),
      });

      const events = calls.filter((c) => c[0] === 'event');
      expect(events).toHaveLength(2);
      expect(events[0][1]).toBe('parked');
      expect(events[0][2]).toBe(10);
      expect(events[0][3]).toContain('(fail)');
      expect(events.some((e) => e[1] === 'fail')).toBe(false);
      expect(events.at(-1)).toEqual([
        'event',
        'lane-done',
        'app',
        'lane complete (0 merged, 0 awaiting review, 0 skipped, 0 decomposed, 1 parked)',
        { lane: 'app' },
      ]);
    });

    it('reaps the parked worktree exactly once when ship throws a LaneParkError', async () => {
      const reapWorktree = vi.fn(async () => {});
      await runLane('app', [12], '/repo', 'on-par/software-factory', paths, {
        ship: async () => {
          throw new LaneParkError('plan escalated: needs a human decision', 'escalate');
        },
        waitMerge: async () => {},
        pathExists: () => false,
        emitEvent: () => {},
        reapWorktree,
      });

      expect(reapWorktree).toHaveBeenCalledTimes(1);
      expect(reapWorktree).toHaveBeenCalledWith(12);
    });

    it('reaps the worktree of a preflight-parked claim', async () => {
      const reapWorktree = vi.fn(async () => {});
      const claims = [{ issue: 13, decision: { kind: 'park' as const, reason: 'CI for PR #99 ended failure' } }];
      await runLane('app', [], '/repo', 'on-par/software-factory', paths, {
        claimNext: async () => claims.shift() ?? null,
        ship: async () => {
          throw new Error('shipIssue must not run for a parked preflight');
        },
        pathExists: () => false,
        emitEvent: () => {},
        reapWorktree,
      });

      expect(reapWorktree).toHaveBeenCalledTimes(1);
      expect(reapWorktree).toHaveBeenCalledWith(13);
    });

    it('does not reap on merged or awaiting-review outcomes', async () => {
      const reapWorktree = vi.fn(async () => {});
      await runLane('app', [14, 15], '/repo', 'on-par/software-factory', paths, {
        ship: async (issue) => `ship-it/${issue}-x`,
        waitMerge: async (issue) => {
          if (issue === 15) throw new AwaitingReviewError('PR #900 awaiting review', 900);
        },
        pathExists: () => false,
        emitEvent: () => {},
        reapWorktree,
      });

      expect(reapWorktree).not.toHaveBeenCalled();
    });

    it('parks normally and keeps event ownership when the injected reapWorktree rejects', async () => {
      const calls: any[] = [];
      await runLane('app', [16], '/repo', 'on-par/software-factory', paths, {
        ship: async () => {
          throw new LaneParkError('router exhausted', 'timeout');
        },
        pathExists: () => false,
        emitEvent: (_events: string, type: string, issue: string | number, msg: string, extra?: any) =>
          calls.push(['event', type, issue, msg, extra]),
        releaseIssue: async (issue, outcome) => {
          calls.push(['release', issue, outcome]);
        },
        reapWorktree: async () => {
          throw new Error('reap exploded');
        },
      });

      expect(calls).toContainEqual(['release', 16, 'parked']);
      const events = calls.filter((c) => c[0] === 'event');
      expect(events[0][1]).toBe('parked');
      expect(events.at(-1)?.[1]).toBe('lane-done');
      expect(events.at(-1)?.[3]).toContain('1 parked');
    });

    it('parks the lane without re-emitting the terminal event (land path owns it) on a conflict error from waitMerge', async () => {
      const calls: any[] = [];
      await runLane('app', [11], '/repo', 'on-par/software-factory', paths, {
        ship: async (issue) => {
          calls.push(['ship', issue]);
          return 'ship-it/11-x';
        },
        waitMerge: async () => {
          throw new LandConflictError('rebase conflict on ship-it/11-x — parked');
        },
        pathExists: () => false,
        emitEvent: (_events: string, type: string, issue: string | number, msg: string, extra?: any) =>
          calls.push(['event', type, issue, msg, extra]),
      });

      expect(calls[0]).toEqual(['ship', 11]);
      const events = calls.filter((c) => c[0] === 'event');
      expect(events).toHaveLength(2);
      expect(events[0][1]).toBe('parked');
      expect(events[0][2]).toBe(11);
      expect(events[0][3]).toContain('(conflict)');
      expect(events.some((e) => e[1] === 'conflict')).toBe(false);
      expect(events.at(-1)).toEqual([
        'event',
        'lane-done',
        'app',
        'lane complete (0 merged, 0 awaiting review, 0 skipped, 0 decomposed, 1 parked)',
        { lane: 'app' },
      ]);
    });
  });
});
