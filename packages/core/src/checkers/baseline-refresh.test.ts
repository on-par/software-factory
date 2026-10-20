import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ModelRouter } from '../router/index.js';
import type { CheckerOutput } from '../types/index.js';
import type { CommandResult } from '../utils/command-runner.js';
import { BaselineCache, hashBaselineCheckerConfig, hashBaselineEnv } from './baseline-cache.js';
import { runBaselineCheckers } from './baseline.js';

const SHA = 'd'.repeat(40);
const router = {} as ModelRouter;
const command = (stdout = ''): CommandResult => ({
  command: [],
  stdout,
  stderr: '',
  exitCode: 0,
  killed: false,
  timedOut: false,
  ok: true,
});

describe('baseline cache refresh', () => {
  let directory: string;

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('reuses by default and bypasses reads while writing selected results through', async () => {
    directory = await mkdtemp(join(tmpdir(), 'baseline-refresh-'));
    const cache = new BaselineCache(join(directory, 'cache.json'));
    const env = { A: '1' };
    const envHash = hashBaselineEnv(env);
    const configHash = hashBaselineCheckerConfig(null);
    const old: CheckerOutput[] = [{ checker: 'tests', result: 'FAIL', details: 'stale' }];
    await cache.set(SHA, envHash, configHash, old);
    await cache.set('e'.repeat(40), envHash, configHash, [{ checker: 'tests', result: 'FAIL', details: 'other sha' }]);
    const runCheckers = vi.fn(async () => ({
      failures: 0,
      passes: 1,
      skips: 0,
      total: 1,
      results: [{ checker: 'tests', result: 'PASS' as const, details: 'fresh pass' }],
    }));
    const deps = {
      runCommand: vi.fn(async () => command()),
      runCheckers: runCheckers as never,
      makeTempDir: async () => mkdtemp(join(directory, 'worktree-parent-')),
    };
    const options = {
      baseSha: SHA,
      laneWorktree: directory,
      failing: [{ checker: 'tests', result: 'FAIL' as const, details: '' }],
      ctx: { worktree: directory, specPath: '', env },
      router,
      constitution: null,
      cache,
      deps,
    };
    const reused = await runBaselineCheckers(options);
    expect(reused.checkers[0]).toMatchObject({ verdict: 'fails-on-base', cached: true });
    expect(runCheckers).not.toHaveBeenCalled();

    const refreshed = await runBaselineCheckers({ ...options, bypassCache: true });
    expect(runCheckers).toHaveBeenCalledOnce();
    expect(refreshed.checkers[0]).toMatchObject({ verdict: 'clean-on-base', baseResult: 'PASS' });
    expect(await cache.get(SHA, envHash, configHash, 'tests')).toMatchObject({ result: 'PASS', details: 'fresh pass' });
    expect(await cache.get('e'.repeat(40), envHash, configHash, 'tests')).toMatchObject({ details: 'other sha' });
  });
});
