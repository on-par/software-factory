// packages/cli/src/cli/run-lane-breaker.test.ts — runLane tests, moved from cli.test.ts (#2800)

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type BaseHold, createBaseHoldGate, readBaseHold } from './base-hold.js';
import { LaneEnvironmentPauseError, LaneParkError } from './index.js';
import { renderLanePausedComment, runLane } from './run-lane.js';

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

    describe('lane breaker (#1918)', () => {
      const parkErr = (signature?: string) =>
        new LaneParkError('check failed', 'escalate', { failureSignature: signature, failingChecks: ['tests'] });
      const harness = (behavior: Record<number, string | Error>, queued: number[]) => {
        const shipped: number[] = [];
        const events: any[] = [];
        const released: any[] = [];
        const claimNext = vi.fn(async () => buildClaim(queued.shift()));
        const commentIssue = vi.fn(async (_issue: number, _body: string) => {});
        const deps = {
          claimNext,
          commentIssue,
          ship: async (issue: number) => {
            shipped.push(issue);
            const b = behavior[issue];
            if (b instanceof Error) throw b;
            return 'branch';
          },
          waitMerge: async () => {},
          releaseIssue: async (issue: number, outcome: string) => {
            released.push([issue, outcome]);
          },
          pathExists: () => false,
          emitEvent: ((...args: any[]) => {
            events.push(args);
          }) as any,
        };
        return { shipped, events, released, claimNext, deps, commentIssue };
      };
      const kinds = (events: any[], kind: string) => events.filter((e) => e[1] === kind);

      it('pauses the lane after consecutive parks with the same signature', async () => {
        const h = harness({ 1: parkErr('sig-A'), 2: parkErr('sig-A'), 3: parkErr('sig-A') }, [1, 2, 3]);
        await runLane('app', [], '/repo', 'on-par/software-factory', paths, { ...h.deps, laneBreakerThreshold: 2 });

        expect(h.shipped).toEqual([1, 2]);
        expect(h.claimNext).toHaveBeenCalledTimes(2);
        expect(kinds(h.events, 'lane-paused')).toHaveLength(1);
        expect(kinds(h.events, 'lane-paused')[0][4]).toEqual({
          lane: 'app',
          lanePaused: { lane: 'app', signature: 'sig-A', failingChecks: ['tests'], firstIssue: 1, secondIssue: 2 },
        });
        expect(kinds(h.events, 'lane-done')).toHaveLength(0);
        expect(kinds(h.events, 'parked')[1][3]).toContain("lane 'app' paused (lane breaker)");
        expect(h.released).toEqual([
          [1, 'parked'],
          [2, 'parked'],
        ]);
      });

      it('posts one pause comment on the second parked issue', async () => {
        const h = harness({ 1: parkErr('sig-A'), 2: parkErr('sig-A'), 3: parkErr('sig-A') }, [1, 2, 3]);
        await runLane('app', [], '/repo', 'on-par/software-factory', paths, { ...h.deps, laneBreakerThreshold: 2 });

        expect(h.commentIssue).toHaveBeenCalledTimes(1);
        const [issue, body] = h.commentIssue.mock.calls[0];
        expect(issue).toBe(2);
        expect(body).toContain('#1');
        expect(body).toContain('`tests`');
        expect(body).toContain('factory run');
        expect(body).toContain("'app'");
        expect(h.commentIssue.mock.calls.some(([i]) => i === 1 || i === 3)).toBe(false);
      });

      it('posts no pause comment when the lane does not trip', async () => {
        const differing = harness({ 1: parkErr('sig-A'), 2: parkErr('sig-B') }, [1, 2, 3]);
        await runLane('app', [], '/repo', 'on-par/software-factory', paths, {
          ...differing.deps,
          laneBreakerThreshold: 2,
        });
        expect(differing.commentIssue).not.toHaveBeenCalled();

        const off = harness({ 1: parkErr('sig-A'), 2: parkErr('sig-A'), 3: parkErr('sig-A') }, [1, 2, 3]);
        await runLane('app', [], '/repo', 'on-par/software-factory', paths, { ...off.deps, laneBreakerThreshold: 0 });
        expect(off.commentIssue).not.toHaveBeenCalled();
      });

      it('still pauses when the comment fails', async () => {
        const h = harness({ 1: parkErr('sig-A'), 2: parkErr('sig-A'), 3: parkErr('sig-A') }, [1, 2, 3]);
        h.commentIssue.mockRejectedValue(new Error('github down'));
        await runLane('app', [], '/repo', 'on-par/software-factory', paths, { ...h.deps, laneBreakerThreshold: 2 });

        expect(kinds(h.events, 'lane-paused')).toHaveLength(1);
        expect(kinds(h.events, 'lane-done')).toHaveLength(0);
        expect(h.shipped).toEqual([1, 2]);
      });

      it('renders none recorded when no failing checks were shared', () => {
        const body = renderLanePausedComment({
          lane: 'app',
          signature: 'sig-A',
          failingChecks: [],
          firstIssue: 1,
          secondIssue: 2,
        });
        expect(body).toContain('none recorded');
      });

      it('does not pause when signatures differ', async () => {
        const h = harness({ 1: parkErr('sig-A'), 2: parkErr('sig-B') }, [1, 2, 3]);
        await runLane('app', [], '/repo', 'on-par/software-factory', paths, { ...h.deps, laneBreakerThreshold: 2 });

        expect(h.shipped).toEqual([1, 2, 3]);
        expect(kinds(h.events, 'lane-paused')).toHaveLength(0);
        expect(kinds(h.events, 'lane-done')).toHaveLength(1);
      });

      it('resets the streak on a merge, then trips on a fresh streak', async () => {
        const h = harness({ 1: parkErr('sig-A'), 3: parkErr('sig-A'), 4: parkErr('sig-A') }, [1, 2, 3]);
        await runLane('app', [], '/repo', 'on-par/software-factory', paths, { ...h.deps, laneBreakerThreshold: 2 });
        expect(kinds(h.events, 'lane-paused')).toHaveLength(0);
        expect(kinds(h.events, 'lane-done')).toHaveLength(1);

        const h2 = harness({ 1: parkErr('sig-A'), 3: parkErr('sig-A'), 4: parkErr('sig-A') }, [1, 2, 3, 4]);
        await runLane('app', [], '/repo', 'on-par/software-factory', paths, { ...h2.deps, laneBreakerThreshold: 2 });
        const paused = kinds(h2.events, 'lane-paused');
        expect(paused).toHaveLength(1);
        expect(paused[0][4].lanePaused).toMatchObject({ firstIssue: 3, secondIssue: 4 });
      });

      it('leaves other lanes running when one lane pauses', async () => {
        const a = harness({ 1: parkErr('sig-A'), 2: parkErr('sig-A'), 3: parkErr('sig-A') }, [1, 2, 3]);
        const b = harness({}, [11, 12, 13]);
        await Promise.all([
          runLane('a', [], '/repo', 'on-par/software-factory', paths, { ...a.deps, laneBreakerThreshold: 2 }),
          runLane('b', [], '/repo', 'on-par/software-factory', paths, { ...b.deps, laneBreakerThreshold: 2 }),
        ]);

        expect(a.shipped).toEqual([1, 2]);
        expect(kinds(a.events, 'lane-paused')).toHaveLength(1);
        expect(b.shipped).toEqual([11, 12, 13]);
        expect(kinds(b.events, 'lane-paused')).toHaveLength(0);
        expect(kinds(b.events, 'lane-done')).toHaveLength(1);
      });

      it.each([0, undefined])('never pauses when the threshold is %s', async (laneBreakerThreshold) => {
        const h = harness({ 1: parkErr('sig-A'), 2: parkErr('sig-A'), 3: parkErr('sig-A') }, [1, 2, 3]);
        await runLane('app', [], '/repo', 'on-par/software-factory', paths, { ...h.deps, laneBreakerThreshold });

        expect(h.shipped).toEqual([1, 2, 3]);
        expect(kinds(h.events, 'lane-paused')).toHaveLength(0);
        expect(kinds(h.events, 'lane-done')[0][3]).toContain('3 parked');
      });

      it('does not pause on parks without a signature', async () => {
        const h = harness({ 1: new Error('boom'), 2: new Error('boom'), 3: parkErr(''), 4: parkErr('') }, [1, 2, 3, 4]);
        await runLane('app', [], '/repo', 'on-par/software-factory', paths, { ...h.deps, laneBreakerThreshold: 2 });

        expect(h.shipped).toEqual([1, 2, 3, 4]);
        expect(kinds(h.events, 'lane-paused')).toHaveLength(0);
      });
    });

    describe('base hold claim gate (#2349)', () => {
      const hold: BaseHold = {
        repo: 'on-par/software-factory',
        baseSha: 'b'.repeat(40),
        failingChecks: ['tests', 'lint'],
        since: '2026-01-01T00:00:00.000Z',
      };
      const gateRun = async (baseHoldGate: () => Promise<any>, issues: number[] = [], queue: number[] = [1]) => {
        const shipped: number[] = [];
        const events: any[] = [];
        const claimNext = vi.fn(async () => buildClaim(queue.shift()));
        await runLane('app', issues, '/repo', 'on-par/software-factory', paths, {
          claimNext,
          ship: async (issue: number) => {
            shipped.push(issue);
            return 'merged';
          },
          waitMerge: async () => {},
          pathExists: () => false,
          emitEvent: ((...args: any[]) => {
            events.push(args);
          }) as any,
          baseHoldGate,
        });
        return { shipped, events, claimNext };
      };

      it('does not claim while the hold matches origin/main and CI is not green', async () => {
        const r = await gateRun(async () => ({ kind: 'hold', hold }));
        expect(r.claimNext).toHaveBeenCalledTimes(0);
        const warns = r.events.filter((e) => e[1] === 'warn');
        expect(warns).toHaveLength(1);
        expect(warns[0][3]).toContain('not claiming');
        expect(warns[0][3]).toContain('bbbbbbbb');
        expect(r.events.filter((e) => e[1] === 'lane-done')).toHaveLength(0);
      });

      it('claims normally when the gate returns claim', async () => {
        const r = await gateRun(async () => ({ kind: 'claim' }));
        expect(r.claimNext).toHaveBeenCalled();
        expect(r.shipped).toEqual([1]);
      });

      it('claims when the gate throws', async () => {
        const r = await gateRun(async () => {
          throw new Error('boom');
        });
        expect(r.claimNext).toHaveBeenCalled();
        expect(r.shipped).toEqual([1]);
      });

      it('does not gate seeded local issues', async () => {
        const gate = vi.fn(async () => ({ kind: 'hold', hold }));
        const r = await gateRun(gate, [1], []);
        expect(r.shipped).toEqual([1]);
        expect(gate).toHaveBeenCalledTimes(1); // only once the seeded issues are exhausted
        expect(r.claimNext).toHaveBeenCalledTimes(0);
      });
    });

    describe('environment pause (#1928)', () => {
      let holdDir: string;
      beforeEach(async () => {
        holdDir = await mkdtemp(join(tmpdir(), 'factory-env-pause-'));
      });
      afterEach(async () => {
        await rm(holdDir, { recursive: true, force: true });
      });

      const runPause = async (baseHold: string, laneBreakerThreshold?: number) => {
        const shipped: number[] = [];
        const events: any[] = [];
        const released: any[] = [];
        const queue = [1, 2];
        const claimNext = vi.fn(async () => buildClaim(queue.shift()));
        await runLane(
          'app',
          [],
          '/repo',
          'on-par/software-factory',
          { ...paths, baseHold },
          {
            claimNext,
            ship: async (issue: number) => {
              shipped.push(issue);
              throw new LaneEnvironmentPauseError('base broken', {
                baseSha: 'abc1234567890def',
                failingChecks: ['tests'],
                failureSignature: 'sig',
              });
            },
            waitMerge: async () => {},
            releaseIssue: async (issue: number, outcome: string) => {
              released.push([issue, outcome]);
            },
            pathExists: () => false,
            emitEvent: ((...args: any[]) => {
              events.push(args);
            }) as any,
            laneBreakerThreshold,
          },
        );

        const of = (kind: string) => events.filter((e) => e[1] === kind);
        expect(shipped).toEqual([1]);
        expect(released).toEqual([[1, 'queued']]);
        expect(of('parked')).toHaveLength(0);
        expect(of('lane-done')).toHaveLength(0);
        expect(claimNext).toHaveBeenCalledTimes(1);
        expect(of('lane-paused')).toHaveLength(1);
        expect(of('lane-paused')[0][4].lanePaused).toEqual({
          lane: 'app',
          signature: 'sig',
          failingChecks: ['tests'],
          firstIssue: 1,
          secondIssue: 1,
          cause: 'environment',
          baseSha: 'abc1234567890def',
        });
      };

      it.each([0, undefined])(
        'releases the issue to queued and pauses the lane (threshold %s)',
        async (laneBreakerThreshold) => {
          const holdFile = join(holdDir, 'state', 'base-hold.json');
          await runPause(holdFile, laneBreakerThreshold);

          const hold = readBaseHold(holdFile);
          expect(hold).toEqual({
            repo: 'on-par/software-factory',
            baseSha: 'abc1234567890def',
            failingChecks: ['tests'],
            since: expect.any(String),
          });
          expect(Number.isNaN(Date.parse(hold!.since))).toBe(false);
        },
      );

      it.each([
        [true, 0],
        [false, 1],
        [undefined, 1],
      ])('buildPreserved=%s reaps the worktree %s time(s) (#2564)', async (buildPreserved, reaps) => {
        const reapWorktree = vi.fn(async (_issue: number) => {});
        await runLane(
          'app',
          [],
          '/repo',
          'on-par/software-factory',
          { ...paths, baseHold: join(holdDir, 'state', 'base-hold.json') },
          {
            claimNext: vi.fn(async () => buildClaim(1)),
            ship: async () => {
              throw new LaneEnvironmentPauseError('base broken', {
                baseSha: 'abc1234567890def',
                failingChecks: ['tests'],
                buildPreserved,
              });
            },
            waitMerge: async () => {},
            releaseIssue: async () => {},
            pathExists: () => false,
            emitEvent: (() => {}) as any,
            reapWorktree,
          },
        );
        expect(reapWorktree).toHaveBeenCalledTimes(reaps);
      });

      it('still releases and pauses when the hold write fails', async () => {
        await writeFile(join(holdDir, 'file'), 'not a dir');
        await runPause(join(holdDir, 'file', 'base-hold.json'));
      });

      const SHA40 = 'a'.repeat(40);
      // One supervisor poll: a fresh runLane with a fresh claimNext, sharing the on-disk hold.
      const poll = async (
        baseHold: string,
        queue: number[],
        gitOut: string,
        laneDeps: Record<string, unknown> = {},
      ) => {
        const shipped: number[] = [];
        const claimNext = vi.fn(async () => buildClaim(queue.shift()));
        await runLane(
          'app',
          [],
          '/repo',
          'on-par/software-factory',
          { ...paths, baseHold },
          {
            claimNext,
            ship: async (issue: number) => {
              shipped.push(issue);
              throw new LaneEnvironmentPauseError('base broken', {
                baseSha: SHA40,
                failingChecks: ['tests'],
                failureSignature: 'sig',
              });
            },
            waitMerge: async () => {},
            releaseIssue: async () => {},
            pathExists: () => false,
            emitEvent: (() => {}) as any,
            baseHoldGate: createBaseHoldGate({
              file: baseHold,
              repo: 'on-par/software-factory',
              git: async () => gitOut,
              listCheckRuns: async () => [{ status: 'completed', conclusion: 'failure' }],
            }),
            ...laneDeps,
          },
        );
        return { shipped, claimNext };
      };

      it('a restarted lane does not re-claim after LaneEnvironmentPauseError while origin/main is unchanged', async () => {
        const holdFile = join(holdDir, 'state', 'base-hold.json');
        const queue = [1, 2];
        const gitOut = `${SHA40}\trefs/heads/main\n`;
        const first = await poll(holdFile, queue, gitOut);
        expect(first.shipped).toEqual([1]);
        expect(readBaseHold(holdFile)?.baseSha).toBe(SHA40);

        const second = await poll(holdFile, queue, gitOut);
        expect(second.claimNext).toHaveBeenCalledTimes(0);
        expect(second.shipped).toEqual([]);
      });

      it('cycles an issue at most once per base SHA across repeated polls', async () => {
        const holdFile = join(holdDir, 'state', 'base-hold.json');
        const queue = [1, 2];
        const gitOut = `${SHA40}\trefs/heads/main\n`;
        const runs = [await poll(holdFile, queue, gitOut)];
        for (let n = 0; n < 3; n++) runs.push(await poll(holdFile, queue, gitOut));

        expect(runs.flatMap((r) => r.shipped)).toEqual([1]);
        expect(runs.reduce((total, r) => total + r.claimNext.mock.calls.length, 0)).toBe(1);
      });
    });
  });
});
