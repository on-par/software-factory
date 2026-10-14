// packages/cli/src/cli/supervise.test.ts — factory supervise tests, moved from cli-commands.test.ts and cli.test.ts (#2797)

import { readFileSync, rmSync, writeFileSync } from 'node:fs';

import { resolveBranchPrefix } from '@on-par/factory-core/internal';
import { describe, expect, it } from 'vitest';

import { createIngestHook, createSuperviseRunQueue } from './index.js';
import {
  coreFakes,
  errored,
  h,
  installShipHarness,
  paths,
  runMainWith,
  trackEnv,
} from './test-support/ship-harness.js';

installShipHarness();

const runMain = (...args: string[]) => runMainWith(undefined, ...args);

describe('cli', () => {
  describe('supervise', () => {
    it('names the branch with the default factory prefix when --branch-prefix is omitted', async () => {
      writeFileSync(paths().queue, 'app 5\n');
      const branches: string[] = [];
      h.setupWorktreeImpl = async (_r, branch) => {
        branches.push(branch);
      };
      const res = await runMain('supervise', '--now', '--local-queue');
      expect(res.exited).toBe(false);
      expect(branches[0]).toEqual(expect.stringMatching(/^factory\/\d+-/));
    });

    it('names the branch and worktree with --branch-prefix sf', async () => {
      writeFileSync(paths().queue, 'app 5\n');
      const calls: string[][] = [];
      h.setupWorktreeImpl = async (_r, branch, worktree) => {
        calls.push([branch, worktree]);
      };
      const res = await runMain('supervise', '--now', '--local-queue', '--branch-prefix', 'sf');
      expect(res.exited).toBe(false);
      expect(calls[0][0]).toEqual(expect.stringMatching(/^sf\/\d+-/));
      expect(calls[0][1]).toContain('-factory-sf-');
    });
    it('exits 2 when the queue is empty', async () => {
      writeFileSync(paths().queue, '# just comments\n');
      const res = await runMain('supervise', '--now', '--local-queue');
      expect(res).toEqual({ exited: true, code: 2 });
    });

    it('exits 2 on invalid usage knobs', async () => {
      writeFileSync(paths().queue, 'app 1\n');
      process.env.FACTORY_USAGE_CAP = 'abc';
      const res = await runMain('supervise', '--now', '--local-queue');
      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('FACTORY_USAGE_CAP');
    });

    it('exits 2 when the queue contains only malformed lines, and warns why', async () => {
      writeFileSync(paths().queue, 'app abc\n');
      const res = await runMain('supervise', '--now', '--local-queue');
      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('malformed');
    });

    it('--now runs the queue once end-to-end and finishes once the queue drains without STOP', async () => {
      process.env.FACTORY_MERGE = '1';
      writeFileSync(paths().queue, 'app 1\n');
      const res = await runMain('supervise', '--now', '--local-queue');
      expect(res.exited).toBe(false);
      const events = readFileSync(paths().events, 'utf-8');
      expect(events).toContain('supervisor-done');
      expect(events).toContain('run-done');
    }, 20_000);

    it('without --local-queue, counts pending work via GitHub Issues and exits 2 when nothing is queued', async () => {
      rmSync(paths().queue, { force: true });
      const res = await runMain('supervise', '--now');
      expect(res).toEqual({ exited: true, code: 2 });
      expect(h.octokit.rest.issues.listForRepo).toHaveBeenCalled();
    });

    it('auto-merge flag: factory supervise --auto-merge records the override for the cycles it drives', async () => {
      writeFileSync(paths().queue, 'app 1\n');
      const res = await runMain('supervise', '--now', '--local-queue', '--auto-merge');
      expect(res.exited).toBe(false);
      expect(JSON.parse(readFileSync(paths().runFlags, 'utf-8'))).toEqual({ autoMerge: true });
    }, 20_000);

    it('usage threshold and poll flags: factory supervise wires both gates and logs their sources', async () => {
      trackEnv('FACTORY_STOP_AT', 'FACTORY_RESUME_AT', 'FACTORY_USAGE_POLL');
      process.env.FACTORY_STOP_AT = '0.5';
      process.env.FACTORY_RESUME_AT = '0.4';
      process.env.FACTORY_USAGE_POLL = '60';
      writeFileSync(paths().queue, 'app 1\n');
      const res = await runMain(
        'supervise',
        '--now',
        '--local-queue',
        '--usage-threshold',
        '0.7',
        '--usage-poll',
        '15',
      );
      expect(res.exited).toBe(false);
      expect(coreFakes.watchUsage).toHaveBeenCalledWith(expect.objectContaining({ stopAt: 0.7, pollMs: 15_000 }));
      const events = readFileSync(paths().events, 'utf-8');
      expect(events).toContain('flag: --usage-threshold');
      expect(events).toContain('flag: --usage-poll');
    }, 20_000);

    it('usage threshold and poll flags: invalid factory supervise values name the offending flag', async () => {
      writeFileSync(paths().queue, 'app 1\n');
      const res = await runMain('supervise', '--now', '--local-queue', '--usage-poll', '0');
      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('--usage-poll');
    });
  });

  describe('createSuperviseRunQueue', () => {
    const paths = { queue: '/repo/.factory/queue', events: '/repo/.factory/events.ndjson' } as any;

    it('runs cmdRun when the queue is non-empty', async () => {
      let cmdRunCalls = 0;
      const events: any[] = [];
      const runQueue = createSuperviseRunQueue(
        paths,
        { enabled: true, label: 'ready', lane: 'auto', maxPerCycle: 20 },
        {
          cmdRunFn: async () => {
            cmdRunCalls++;
          },
          readQueueFile: () => 'auto 1\n',
          emitEvent: (...args: any[]) => events.push(args),
        },
      );

      await runQueue();

      expect(cmdRunCalls).toBe(1);
      expect(events).toHaveLength(0);
    });

    it('is a no-op and logs idle when the queue is empty and ingest is enabled', async () => {
      let cmdRunCalls = 0;
      const events: any[] = [];
      const runQueue = createSuperviseRunQueue(
        paths,
        { enabled: true, label: 'ready', lane: 'auto', maxPerCycle: 20 },
        {
          cmdRunFn: async () => {
            cmdRunCalls++;
          },
          readQueueFile: () => '',
          emitEvent: (...args: any[]) => events.push(args),
        },
      );

      await runQueue();

      expect(cmdRunCalls).toBe(0);
      expect(events).toEqual([[paths.events, 'idle', 'auto', 'queue empty — waiting for ready issues']]);
    });

    it('runs cmdRun even on an empty queue when ingest is disabled', async () => {
      let cmdRunCalls = 0;
      const runQueue = createSuperviseRunQueue(
        paths,
        { enabled: false, label: 'ready', lane: 'auto', maxPerCycle: 20 },
        {
          cmdRunFn: async () => {
            cmdRunCalls++;
          },
          readQueueFile: () => '',
        },
      );

      await runQueue();

      expect(cmdRunCalls).toBe(1);
    });

    it('an injected pendingCount returning 0 with ingest enabled emits idle and skips cmdRunFn', async () => {
      let cmdRunCalls = 0;
      const events: any[] = [];
      const runQueue = createSuperviseRunQueue(
        paths,
        { enabled: true, label: 'ready', lane: 'auto', maxPerCycle: 20 },
        {
          cmdRunFn: async () => {
            cmdRunCalls++;
          },
          pendingCount: async () => 0,
          emitEvent: (...args: any[]) => events.push(args),
        },
      );

      await runQueue();

      expect(cmdRunCalls).toBe(0);
      expect(events).toEqual([[paths.events, 'idle', 'auto', 'queue empty — waiting for ready issues']]);
    });

    it('an injected pendingCount returning a nonzero count calls cmdRunFn', async () => {
      let cmdRunCalls = 0;
      const runQueue = createSuperviseRunQueue(
        paths,
        { enabled: true, label: 'ready', lane: 'auto', maxPerCycle: 20 },
        {
          cmdRunFn: async () => {
            cmdRunCalls++;
          },
          pendingCount: async () => 2,
        },
      );

      await runQueue();

      expect(cmdRunCalls).toBe(1);
    });
  });

  describe('createIngestHook', () => {
    const paths = {
      queue: '/repo/.factory/queue',
      events: '/repo/.factory/events.ndjson',
      ingestWatermark: '/repo/.factory/ingest-watermark',
    } as any;
    const ingestCfg = { enabled: true, label: 'ready', lane: 'auto', maxPerCycle: 20 };

    it.each([
      [{ branchPrefix: 'sf' }, 'sf'],
      [{}, 'factory'],
    ])('passes the branch prefix to auto-ingest (%j)', async (deps, expected) => {
      let seen: string | undefined;
      const hook = createIngestHook('/repo', paths, ingestCfg, {
        ...deps,
        runAutoIngestFn: async (opts) => {
          seen = opts.branchPrefix;
          return {
            scannedAt: '2026-07-20T00:00:00.000Z',
            candidates: 0,
            appended: [],
            skippedInQueue: [],
            skippedInFlight: [],
            skippedStale: [],
            skippedFileOverlap: [],
            watermark: '2026-07-20T00:00:00.000Z',
          };
        },
        emitEvent: () => {},
      });
      await hook();
      expect(seen).toBe(expected);
    });

    it('logs an ingested event and returns the appended count when issues are appended', async () => {
      const events: any[] = [];
      const hook = createIngestHook('/repo', paths, ingestCfg, {
        runAutoIngestFn: async (opts) => {
          expect(opts).toEqual({
            repoDir: '/repo',
            queueFile: paths.queue,
            watermarkFile: paths.ingestWatermark,
            label: 'ready',
            lane: 'auto',
            maxPerCycle: 20,
            branchPrefix: resolveBranchPrefix(),
            forceAdmit: false,
          });
          return {
            scannedAt: '2026-07-20T00:00:00.000Z',
            candidates: 1,
            appended: [42],
            skippedInQueue: [],
            skippedInFlight: [],
            skippedStale: [],
            skippedFileOverlap: [],
            watermark: '2026-07-20T00:00:00.000Z',
          };
        },
        emitEvent: (...args: any[]) => events.push(args),
      });

      const appended = await hook();

      expect(appended).toBe(1);
      expect(events).toEqual([[paths.events, 'ingested', 'auto', 'auto-ingest appended 1 ready issue(s): 42']]);
    });

    it('does not log when nothing was appended', async () => {
      const events: any[] = [];
      const hook = createIngestHook('/repo', paths, ingestCfg, {
        runAutoIngestFn: async () => ({
          scannedAt: '2026-07-20T00:00:00.000Z',
          candidates: 0,
          appended: [],
          skippedInQueue: [],
          skippedInFlight: [],
          skippedStale: [],
          skippedFileOverlap: [],
          watermark: '2026-07-20T00:00:00.000Z',
        }),
        emitEvent: (...args: any[]) => events.push(args),
      });

      const appended = await hook();

      expect(appended).toBe(0);
      expect(events).toHaveLength(0);
    });

    it('emits an ingest_file_overlap_held event per held-back issue, naming the collision', async () => {
      const events: any[] = [];
      const hook = createIngestHook('/repo', paths, ingestCfg, {
        runAutoIngestFn: async () => ({
          scannedAt: '2026-07-20T00:00:00.000Z',
          candidates: 2,
          appended: [42],
          skippedInQueue: [],
          skippedInFlight: [],
          skippedStale: [],
          skippedFileOverlap: [{ issue: 99, collidesWith: 42, path: 'foo.ts' }],
          watermark: '2026-07-20T00:00:00.000Z',
        }),
        emitEvent: (...args: any[]) => events.push(args),
      });

      await hook();

      expect(events).toContainEqual([paths.events, 'ingest_file_overlap_held', 99, expect.stringContaining('#42')]);
    });

    it('catches a runAutoIngest failure, logs a warn event, and returns 0', async () => {
      const events: any[] = [];
      const hook = createIngestHook('/repo', paths, ingestCfg, {
        runAutoIngestFn: async () => {
          throw new Error('gh unavailable');
        },
        emitEvent: (...args: any[]) => events.push(args),
      });

      const appended = await hook();

      expect(appended).toBe(0);
      expect(events).toEqual([[paths.events, 'warn', 'auto', 'auto-ingest failed: gh unavailable']]);
    });
  });
});
