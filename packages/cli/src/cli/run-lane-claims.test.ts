// packages/cli/src/cli/run-lane-claims.test.ts — runLane tests, moved from cli.test.ts (#2800)

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

    it('pollReviewRework runs before each remote claim and a rejection only warns', async () => {
      const calls: string[] = [];
      const events: any[] = [];
      await runLane('app', [], '/repo', 'on-par/software-factory', paths, {
        pathExists: () => false,
        emitEvent: (...args: any[]) => {
          events.push(args);
        },
        pollReviewRework: async () => {
          calls.push('poll');
          throw new Error('boom');
        },
        claimNext: async () => {
          calls.push('claimNext');
          return null;
        },
      });
      expect(calls).toEqual(['poll', 'claimNext']);
      expect(events.some((e) => e[1] === 'warn' && String(e[3]).includes('review-rework poll failed: boom'))).toBe(
        true,
      );
    });

    it('claims issues one at a time from claimNext and releases each as done on the green path', async () => {
      const calls: any[] = [];
      const toClaim = [1, 2];
      await runLane('app', [], '/repo', 'on-par/software-factory', paths, {
        ship: async (issue) => {
          calls.push(['ship', issue]);
          return `ship-it/${issue}-x`;
        },
        waitMerge: async (issue) => {
          calls.push(['waitMerge', issue]);
        },
        pathExists: () => false,
        emitEvent: () => {},
        claimNext: async () => buildClaim(toClaim.shift()),
        releaseIssue: async (issue, outcome) => {
          calls.push(['release', issue, outcome]);
        },
      });

      expect(calls.filter((c) => c[0] === 'ship')).toEqual([
        ['ship', 1],
        ['ship', 2],
      ]);
      expect(calls.filter((c) => c[0] === 'release')).toEqual([
        ['release', 1, 'done'],
        ['release', 2, 'done'],
      ]);
    });

    it('releases as parked and keeps claiming further issues when a park happens', async () => {
      const calls: any[] = [];
      const toClaim = [1, 2];
      await runLane('app', [], '/repo', 'on-par/software-factory', paths, {
        ship: async (issue) => {
          calls.push(['ship', issue]);
          if (issue === 1) throw new LaneParkError('boom', 'fail');
          return `ship-it/${issue}-x`;
        },
        waitMerge: async () => {},
        pathExists: () => false,
        emitEvent: () => {},
        claimNext: async () => {
          calls.push(['claimNext']);
          return buildClaim(toClaim.shift());
        },
        releaseIssue: async (issue, outcome) => {
          calls.push(['release', issue, outcome]);
        },
      });

      expect(calls.filter((c) => c[0] === 'claimNext')).toHaveLength(3);
      expect(calls.filter((c) => c[0] === 'release')).toEqual([
        ['release', 1, 'parked'],
        ['release', 2, 'done'],
      ]);
    });

    it('releases as done on skip, continuing to claim further issues', async () => {
      const calls: any[] = [];
      const toClaim = [1, 2];
      await runLane('app', [], '/repo', 'on-par/software-factory', paths, {
        ship: async (issue) => {
          calls.push(['ship', issue]);
          if (issue === 1) throw new IssueSkippedError('#1 already closed', 'already-closed');
          return `ship-it/${issue}-x`;
        },
        waitMerge: async () => {},
        pathExists: () => false,
        emitEvent: () => {},
        claimNext: async () => buildClaim(toClaim.shift()),
        releaseIssue: async (issue, outcome) => {
          calls.push(['release', issue, outcome]);
        },
      });

      expect(calls.filter((c) => c[0] === 'release')).toEqual([
        ['release', 1, 'done'],
        ['release', 2, 'done'],
      ]);
    });

    it('releases as done on an awaiting-review outcome', async () => {
      const calls: any[] = [];
      const toClaim = [1, 2];
      await runLane('app', [], '/repo', 'on-par/software-factory', paths, {
        ship: async (issue) => {
          calls.push(['ship', issue]);
          return `ship-it/${issue}-x`;
        },
        waitMerge: async (issue) => {
          if (issue === 1) throw new AwaitingReviewError('PR #101 awaiting review', 101);
        },
        pathExists: () => false,
        emitEvent: () => {},
        claimNext: async () => buildClaim(toClaim.shift()),
        releaseIssue: async (issue, outcome) => {
          calls.push(['release', issue, outcome]);
        },
      });

      expect(calls.filter((c) => c[0] === 'release')).toEqual([
        ['release', 1, 'done'],
        ['release', 2, 'done'],
      ]);
    });

    it('releases as queued (returning it to the pool) when STOP aborts a claimed-but-unstarted issue', async () => {
      const calls: any[] = [];
      await runLane('app', [], '/repo', 'on-par/software-factory', paths, {
        ship: async () => {
          throw new Error('ship should not be called');
        },
        waitMerge: async () => {},
        pathExists: () => true,
        emitEvent: (_events, type, issue, msg, extra) => calls.push(['event', type, issue, msg, extra]),
        claimNext: async () => buildClaim(1),
        releaseIssue: async (issue, outcome) => {
          calls.push(['release', issue, outcome]);
        },
      });

      expect(calls.filter((c) => c[0] === 'event' && c[1] === 'stopped')).toHaveLength(1);
      expect(calls.filter((c) => c[0] === 'release')).toEqual([['release', 1, 'queued']]);
    });

    it('releases decompose children as done and claims further only once children are exhausted', async () => {
      const calls: any[] = [];
      const toClaim = [1];
      await runLane('app', [], '/repo', 'on-par/software-factory', paths, {
        ship: async (issue) => {
          calls.push(['ship', issue]);
          if (issue === 1) throw new IssueDecomposedError('issue #1 decomposed into #10, #11', [10, 11]);
          return `ship-it/${issue}-x`;
        },
        waitMerge: async () => {},
        pathExists: () => false,
        emitEvent: () => {},
        claimNext: async () => {
          calls.push(['claimNext']);
          return buildClaim(toClaim.shift());
        },
        releaseIssue: async (issue, outcome) => {
          calls.push(['release', issue, outcome]);
        },
      });

      expect(calls.filter((c) => c[0] === 'ship')).toEqual([
        ['ship', 1],
        ['ship', 10],
        ['ship', 11],
      ]);
      expect(calls.filter((c) => c[0] === 'release')).toEqual([
        ['release', 1, 'done'],
        ['release', 10, 'done'],
        ['release', 11, 'done'],
      ]);
      expect(calls.filter((c) => c[0] === 'claimNext')).toHaveLength(2);
    });

    it('performs no release calls when no queue deps are provided', async () => {
      const calls: any[] = [];
      await runLane('app', [1], '/repo', 'on-par/software-factory', paths, {
        ship: async (issue) => {
          calls.push(['ship', issue]);
          return `ship-it/${issue}-x`;
        },
        waitMerge: async () => {},
        pathExists: () => false,
        emitEvent: () => {},
      });

      expect(calls).toEqual([['ship', 1]]);
    });

    describe('between-issues sweep (#1757)', () => {
      it('sweeps after each release and before the next issue ships', async () => {
        const calls: any[] = [];
        await runLane('app', [1, 2], '/repo', 'on-par/software-factory', paths, {
          ship: async (issue) => {
            calls.push(['ship', issue]);
            if (issue === 1) throw new LaneParkError('nope', 'escalate');
            return `ship-it/${issue}-x`;
          },
          waitMerge: async () => {},
          releaseIssue: async (issue, outcome) => {
            calls.push(['release', issue, outcome]);
          },
          sweepFinished: async (issue) => {
            calls.push(['sweep', issue]);
          },
          pathExists: () => false,
          emitEvent: () => {},
        });

        expect(calls).toEqual([
          ['ship', 1],
          ['release', 1, 'parked'],
          ['sweep', 1],
          ['ship', 2],
          ['release', 2, 'done'],
          ['sweep', 2],
        ]);
      });

      it.each([
        ['awaiting review', () => new AwaitingReviewError('PR #9 awaiting review', 9)],
        ['skipped', () => new IssueSkippedError('already closed', 'already-closed')],
        ['decomposed', () => new IssueDecomposedError('split', [])],
      ])('sweeps once after a %s outcome', async (_name, makeErr) => {
        const calls: any[] = [];
        await runLane('app', [5], '/repo', 'on-par/software-factory', paths, {
          ship: async () => {
            throw makeErr();
          },
          releaseIssue: async (issue, outcome) => {
            calls.push(['release', issue, outcome]);
          },
          sweepFinished: async (issue) => {
            calls.push(['sweep', issue]);
          },
          pathExists: () => false,
          emitEvent: () => {},
        });

        expect(calls).toEqual([
          ['release', 5, 'done'],
          ['sweep', 5],
        ]);
      });

      it('sweeps after a preflight park', async () => {
        const calls: any[] = [];
        const claims = [{ issue: 6, decision: { kind: 'park' as const, reason: 'held' } }];
        await runLane('app', [], '/repo', 'on-par/software-factory', paths, {
          claimNext: async () => claims.shift() ?? null,
          releaseIssue: async (issue, outcome) => {
            calls.push(['release', issue, outcome]);
          },
          sweepFinished: async (issue) => {
            calls.push(['sweep', issue]);
          },
          pathExists: () => false,
          emitEvent: () => {},
        });

        expect(calls).toEqual([
          ['release', 6, 'parked'],
          ['sweep', 6],
        ]);
      });

      it('does not sweep on STOP', async () => {
        const sweepFinished = vi.fn(async () => {});
        await runLane('app', [1], '/repo', 'on-par/software-factory', paths, {
          ship: async () => 'b',
          sweepFinished,
          pathExists: () => true,
          emitEvent: () => {},
        });

        expect(sweepFinished).not.toHaveBeenCalled();
      });

      it('a failing sweep never changes lane flow', async () => {
        const shipped: number[] = [];
        const events: string[] = [];
        await runLane('app', [1, 2], '/repo', 'on-par/software-factory', paths, {
          ship: async (issue) => {
            shipped.push(issue);
            return `ship-it/${issue}-x`;
          },
          waitMerge: async () => {},
          sweepFinished: async () => {
            throw new Error('sweep exploded');
          },
          pathExists: () => false,
          emitEvent: (_p, kind) => {
            events.push(kind);
          },
        });

        expect(shipped).toEqual([1, 2]);
        expect(events.filter((k) => k === 'lane-done')).toHaveLength(1);
        expect(events).not.toContain('parked');
      });
    });

    it("two lanes: lane B's between-issues sweep sees lane A's in-flight issue as protected (#2964)", async () => {
      const activeIssues = new Set<number>();
      let releaseA!: () => void;
      const aGate = new Promise<void>((r) => {
        releaseA = r;
      });
      let aStarted!: () => void;
      const aRunning = new Promise<void>((r) => {
        aStarted = r;
      });
      const snapshots: number[][] = [];
      const base = { pathExists: () => false, emitEvent: () => {}, waitMerge: async () => {}, activeIssues };

      const laneA = runLane('a', [], '/repo', 'o/r', paths, {
        ...base,
        ship: async (issue) => {
          aStarted();
          await aGate;
          return `ship-it/${issue}-x`;
        },
        claimNext: (() => {
          const q = [1];
          return async () => buildClaim(q.shift());
        })(),
      });
      await aRunning;
      await runLane('b', [], '/repo', 'o/r', paths, {
        ...base,
        ship: async (issue) => `ship-it/${issue}-x`,
        claimNext: (() => {
          const q = [2];
          return async () => buildClaim(q.shift());
        })(),
        sweepFinished: async () => {
          snapshots.push([...activeIssues]);
        },
      });

      expect(snapshots).toEqual([[1]]);
      releaseA();
      await laneA;
      expect(activeIssues.size).toBe(0);
    });
  });
});
