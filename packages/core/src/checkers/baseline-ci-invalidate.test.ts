import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';
import type { ModelRouter } from '../router/index.js';
import type { CheckerOutput } from '../types/index.js';
import type { CommandResult } from '../utils/command-runner.js';
import { BaselineCache, hashBaselineCheckerConfig, hashBaselineEnv } from './baseline-cache.js';
import { runBaselineCheckers } from './baseline.js';

const SHA = 'a'.repeat(40);
const tempDirs = createTempDirs();

afterEach(() => tempDirs.cleanup());

const ok = (): CommandResult => ({
  command: [],
  stdout: '',
  stderr: '',
  exitCode: 0,
  killed: false,
  timedOut: false,
  ok: true,
});

const out = (checker: string, result: 'PASS' | 'FAIL'): CheckerOutput => ({ checker, result, details: 'cached' });

describe('runBaselineCheckers CI cross-check (#3540)', () => {
  async function setup(seed: CheckerOutput[]) {
    const dir = await tempDirs.make('baseline-ci-');
    const env = { A: '1' };
    const cache = new BaselineCache(join(dir, 'baseline-cache.json'));
    await cache.set(SHA, hashBaselineEnv(env), hashBaselineCheckerConfig(null), seed);
    const ran: string[][] = [];
    const runCheckers = async (_c: unknown, _r: unknown, _x: unknown, _y: unknown, names: string[]) => {
      ran.push(names);
      return {
        failures: 0,
        passes: names.length,
        skips: 0,
        total: names.length,
        results: names.map((n) => ({ checker: n, result: 'PASS' as const, details: 'fresh' })),
      };
    };
    const lookups: string[] = [];
    const invalidated: [string, string][] = [];
    const greenVerdict = async (sha: string) => {
      lookups.push(sha);
      return { green: true, reason: 'ok' };
    };
    const onCacheInvalidated = (checker: string, reason: string) => {
      invalidated.push([checker, reason]);
    };
    const run = (extra: Partial<Parameters<typeof runBaselineCheckers>[0]>) =>
      runBaselineCheckers({
        baseSha: SHA,
        laneWorktree: dir,
        failing: seed.map((s) => ({ ...s, result: 'FAIL' as const })),
        ctx: { worktree: dir, specPath: '', env },
        router: {} as ModelRouter,
        constitution: null,
        cache,
        deps: {
          runCommand: vi.fn(async () => ok()),
          runCheckers: runCheckers as never,
          makeTempDir: () => mkdtemp(join(dir, 'p-')),
        },
        ...extra,
      });
    const read = (name: string) => cache.get(SHA, hashBaselineEnv(env), hashBaselineCheckerConfig(null), name);
    return { run, ran, lookups, invalidated, greenVerdict, onCacheInvalidated, read };
  }

  it('drops a cached FAIL when CI is green and re-runs the checker once', async () => {
    const { run, ran, invalidated, greenVerdict, onCacheInvalidated, read } = await setup([out('tests', 'FAIL')]);
    const report = await run({ requiredChecksVerdict: greenVerdict, onCacheInvalidated });
    expect(ran).toEqual([['tests']]);
    expect(invalidated).toEqual([['tests', expect.stringContaining('GitHub CI is green')]]);
    expect(report.checkers[0].verdict).toBe('clean-on-base');
    expect((await read('tests'))?.details).toBe('fresh');
  });

  it('keeps a cached FAIL when CI is not green', async () => {
    const { run, ran, invalidated, onCacheInvalidated, read } = await setup([out('tests', 'FAIL')]);
    const report = await run({
      requiredChecksVerdict: async () => ({ green: false, reason: 'pending' }),
      onCacheInvalidated,
    });
    expect(ran).toEqual([]);
    expect(invalidated).toEqual([]);
    expect(report.checkers[0].verdict).toBe('fails-on-base');
    expect((await read('tests'))?.result).toBe('FAIL');
  });

  it('keeps it when the lookup throws or is absent', async () => {
    const { run, ran, invalidated, onCacheInvalidated } = await setup([out('tests', 'FAIL')]);
    const thrown = await run({
      requiredChecksVerdict: async () => {
        throw new Error('rate limited');
      },
      onCacheInvalidated,
    });
    const absent = await run({ onCacheInvalidated });
    expect(thrown.checkers[0].verdict).toBe('fails-on-base');
    expect(absent.checkers[0].verdict).toBe('fails-on-base');
    expect(ran).toEqual([]);
    expect(invalidated).toEqual([]);
  });

  it('never consults CI for a cached PASS', async () => {
    const { run, ran, lookups, greenVerdict } = await setup([out('tests', 'PASS')]);
    await run({ requiredChecksVerdict: greenVerdict });
    expect(lookups).toEqual([]);
    expect(ran).toEqual([]);
  });

  it('looks CI up once for several cached FAILs', async () => {
    const { run, ran, lookups, invalidated, greenVerdict, onCacheInvalidated } = await setup([
      out('tests', 'FAIL'),
      out('lint', 'FAIL'),
    ]);
    await run({ requiredChecksVerdict: greenVerdict, onCacheInvalidated });
    expect(lookups).toEqual([SHA]);
    expect(invalidated.map(([c]) => c).sort()).toEqual(['lint', 'tests']);
    expect(ran).toHaveLength(1);
    expect([...ran[0]].sort()).toEqual(['lint', 'tests']);
  });

  describe('confirmedLocally (#3851)', () => {
    const failRun = (timedOut?: true) => ({
      failures: 1,
      passes: 0,
      skips: 0,
      total: 1,
      results: [{ checker: 'links', result: 'FAIL' as const, details: 'fresh', ...(timedOut ? { timedOut } : {}) }],
    });
    const depsWith = (dir: string, results: ReturnType<typeof failRun>) => ({
      runCommand: vi.fn(async () => ok()),
      runCheckers: vi.fn(async () => results) as never,
      makeTempDir: () => mkdtemp(join(dir, 'q-')),
    });

    it('marks the report confirmedLocally when a fresh base run fails while CI is green (#3851)', async () => {
      const { run } = await setup([out('links', 'FAIL')]);
      const dir = await tempDirs.make('baseline-fresh-');
      const report = await run({
        cache: undefined,
        deps: depsWith(dir, failRun()),
        requiredChecksVerdict: async () => ({ green: true, reason: 'ok' }),
      });
      expect(report.confirmedLocally).toBe(true);
    });

    it('re-run after a CI-green cache invalidation that still fails is confirmedLocally (#3851)', async () => {
      const { run, lookups, greenVerdict } = await setup([out('links', 'FAIL')]);
      const dir = await tempDirs.make('baseline-rerun-');
      const report = await run({ deps: depsWith(dir, failRun()), requiredChecksVerdict: greenVerdict });
      expect(report.confirmedLocally).toBe(true);
      expect(lookups).toEqual([SHA]);
    });

    it('does not mark confirmedLocally when CI is not green, the lookup throws, or the FAIL timed out (#3851)', async () => {
      const { run } = await setup([]);
      const dir = await tempDirs.make('baseline-neg-');
      const failing = [out('links', 'FAIL')];
      const notGreen = await run({
        failing,
        deps: depsWith(dir, failRun()),
        requiredChecksVerdict: async () => ({ green: false, reason: 'red' }),
      });
      const thrown = await run({
        failing,
        deps: depsWith(dir, failRun()),
        requiredChecksVerdict: async () => {
          throw new Error('rate limited');
        },
      });
      const timedOut = await run({
        failing,
        deps: depsWith(dir, failRun(true)),
        requiredChecksVerdict: async () => ({ green: true, reason: 'ok' }),
      });
      expect(notGreen.confirmedLocally).toBeUndefined();
      expect(thrown.confirmedLocally).toBeUndefined();
      expect(timedOut.confirmedLocally).toBeUndefined();
    });
  });
});
