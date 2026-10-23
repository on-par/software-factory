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
    const runCheckers = vi.fn(async (_c: unknown, _r: unknown, _x: unknown, _y: unknown, names: string[]) => ({
      failures: 0,
      passes: names.length,
      skips: 0,
      total: names.length,
      results: names.map((n) => ({ checker: n, result: 'PASS' as const, details: 'fresh' })),
    }));
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
    return { run, runCheckers, read };
  }

  it('drops a cached FAIL when CI is green and re-runs the checker once', async () => {
    const { run, runCheckers, read } = await setup([out('tests', 'FAIL')]);
    const onCacheInvalidated = vi.fn();
    const report = await run({
      requiredChecksVerdict: async () => ({ green: true, reason: 'ok' }),
      onCacheInvalidated,
    });
    expect(runCheckers).toHaveBeenCalledTimes(1);
    expect(runCheckers.mock.calls[0][4]).toEqual(['tests']);
    expect(onCacheInvalidated).toHaveBeenCalledWith('tests', expect.stringContaining('GitHub CI is green'));
    expect(report.checkers[0].verdict).toBe('clean-on-base');
    expect((await read('tests'))?.details).toBe('fresh');
  });

  it('keeps a cached FAIL when CI is not green', async () => {
    const { run, runCheckers, read } = await setup([out('tests', 'FAIL')]);
    const onCacheInvalidated = vi.fn();
    const report = await run({
      requiredChecksVerdict: async () => ({ green: false, reason: 'pending' }),
      onCacheInvalidated,
    });
    expect(runCheckers).not.toHaveBeenCalled();
    expect(onCacheInvalidated).not.toHaveBeenCalled();
    expect(report.checkers[0].verdict).toBe('fails-on-base');
    expect((await read('tests'))?.result).toBe('FAIL');
  });

  it('keeps it when the lookup throws or is absent', async () => {
    const { run, runCheckers } = await setup([out('tests', 'FAIL')]);
    const onCacheInvalidated = vi.fn();
    const thrown = await run({
      requiredChecksVerdict: async () => {
        throw new Error('rate limited');
      },
      onCacheInvalidated,
    });
    const absent = await run({ onCacheInvalidated });
    expect(thrown.checkers[0].verdict).toBe('fails-on-base');
    expect(absent.checkers[0].verdict).toBe('fails-on-base');
    expect(runCheckers).not.toHaveBeenCalled();
    expect(onCacheInvalidated).not.toHaveBeenCalled();
  });

  it('never consults CI for a cached PASS', async () => {
    const { run, runCheckers } = await setup([out('tests', 'PASS')]);
    const requiredChecksVerdict = vi.fn(async () => ({ green: true, reason: 'ok' }));
    await run({ requiredChecksVerdict });
    expect(requiredChecksVerdict).not.toHaveBeenCalled();
    expect(runCheckers).not.toHaveBeenCalled();
  });

  it('looks CI up once for several cached FAILs', async () => {
    const { run, runCheckers } = await setup([out('tests', 'FAIL'), out('lint', 'FAIL')]);
    const requiredChecksVerdict = vi.fn(async () => ({ green: true, reason: 'ok' }));
    const onCacheInvalidated = vi.fn();
    await run({ requiredChecksVerdict, onCacheInvalidated });
    expect(requiredChecksVerdict).toHaveBeenCalledTimes(1);
    expect(onCacheInvalidated).toHaveBeenCalledTimes(2);
    expect(runCheckers).toHaveBeenCalledTimes(1);
  });
});
