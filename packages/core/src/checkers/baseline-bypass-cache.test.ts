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

describe('runBaselineCheckers bypassCache (#3287)', () => {
  it('skips cache reads but still writes fresh results', async () => {
    const dir = await tempDirs.make('baseline-bypass-');
    const env = { A: '1' };
    const cache = new BaselineCache(join(dir, 'baseline-cache.json'));
    const stale: CheckerOutput = { checker: 'tests', result: 'FAIL', details: 'stale' };
    await cache.set(SHA, hashBaselineEnv(env), hashBaselineCheckerConfig(null), [stale]);
    const runCheckers = vi.fn(async () => ({
      failures: 0,
      passes: 1,
      skips: 0,
      total: 1,
      results: [{ checker: 'tests', result: 'PASS' as const, details: 'fresh' }],
    }));
    const report = await runBaselineCheckers({
      baseSha: SHA,
      laneWorktree: dir,
      failing: [stale],
      ctx: { worktree: dir, specPath: '', env },
      router: {} as ModelRouter,
      constitution: null,
      cache,
      bypassCache: true,
      deps: {
        runCommand: vi.fn(async () => ok()),
        runCheckers: runCheckers as never,
        makeTempDir: () => mkdtemp(join(dir, 'p-')),
      },
    });
    expect(runCheckers).toHaveBeenCalledTimes(1);
    expect(report.checkers).toEqual([{ checker: 'tests', verdict: 'clean-on-base', baseResult: 'PASS' }]);
    const stored = await cache.get(SHA, hashBaselineEnv(env), hashBaselineCheckerConfig(null), 'tests');
    expect(stored?.details).toBe('fresh');
  });
});
