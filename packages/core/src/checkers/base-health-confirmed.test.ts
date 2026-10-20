import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import type { EventKind } from '../events/kinds.js';
import type { ModelRouter } from '../router/index.js';
import type { CommandResult } from '../utils/command-runner.js';
import { checkBaseHealth, type BaseHealthOptions } from './base-health.js';
import { BaselineCache, hashBaselineCheckerConfig, hashBaselineEnv } from './baseline-cache.js';
import type { BaselineReport } from './baseline.js';
import { createTempDirs } from '../harness/temp-dir.js';

const SHA = 'b'.repeat(40);

function cmd(stdout: string, exitCode = 0): CommandResult {
  return { command: [], stdout, stderr: '', exitCode, killed: false, timedOut: false, ok: exitCode === 0 };
}

let memo: Map<string, Promise<BaselineReport>>;
let log: Mock<(type: EventKind, msg: string) => void>;

beforeEach(() => {
  memo = new Map();
  log = vi.fn<(type: EventKind, msg: string) => void>();
});

function opts(deps: NonNullable<BaseHealthOptions['deps']>, extra: Partial<BaseHealthOptions> = {}): BaseHealthOptions {
  return {
    worktree: '/tmp/wt',
    constitution: null,
    router: {} as ModelRouter,
    env: { A: '1' },
    log,
    ...extra,
    deps: { memo, runCommand: vi.fn(async () => cmd(`${SHA}\n`)), ...deps },
  };
}

describe('checkBaseHealth cached FAIL with green CI (#3287)', () => {
  const tempDirs = createTempDirs();
  afterEach(() => tempDirs.cleanup());

  const out = (checker: string, result: 'PASS' | 'FAIL', details = '') => ({ checker, result, details });

  async function setup(testsResult: 'PASS' | 'FAIL', details = '', gitAddExit = 0) {
    const dir = await tempDirs.make('base-health-3287-');
    const cachePath = join(dir, 'baseline-cache.json');
    await new BaselineCache(cachePath).set(SHA, hashBaselineEnv({ A: '1' }), hashBaselineCheckerConfig(null), [
      out('compile', 'PASS'),
      out('lint', 'PASS'),
      out('tests', 'FAIL', 'flaky tcpPortProbe'),
    ]);
    const runCheckers = vi.fn(async () => ({
      failures: 0,
      passes: 0,
      skips: 0,
      total: 1,
      results: [out('tests', testsResult, details)],
    }));
    const baselineDeps = {
      runCommand: vi.fn(async (argv: readonly string[]) =>
        cmd('', argv[1] === 'worktree' && argv[2] === 'add' ? gitAddExit : 0),
      ),
      runCheckers: runCheckers as never,
      makeTempDir: () => mkdtemp(join(dir, 'p-')),
    };
    const read = () =>
      new BaselineCache(cachePath).get(SHA, hashBaselineEnv({ A: '1' }), hashBaselineCheckerConfig(null), 'tests');
    return { cachePath, baselineDeps, runCheckers, read };
  }

  const green = async () => ({ green: true, reason: 'ok' });

  it('a cached tests FAIL on a base whose CI is green is re-run once fresh, not re-held (Breaker, c4069f3f)', async () => {
    const { cachePath, baselineDeps, runCheckers, read } = await setup('PASS');
    const res = await checkBaseHealth(
      opts({ baselineDeps, confirmed: new Set() }, { cachePath, requiredChecksVerdict: green }),
    );
    expect(res.kind).toBe('green');
    expect(runCheckers).toHaveBeenCalledTimes(1);
    expect((runCheckers.mock.calls[0] as unknown[])[4]).toEqual(['tests']);
    expect((await read())?.result).toBe('PASS');
  });

  it('a fresh FAIL after a cached FAIL with green CI is red with confirmedLocally and logs one base_divergence', async () => {
    const { cachePath, baselineDeps } = await setup('FAIL', `${'x'.repeat(1000)}TAIL`);
    const res = await checkBaseHealth(
      opts({ baselineDeps, confirmed: new Set() }, { cachePath, requiredChecksVerdict: green }),
    );
    expect(res).toMatchObject({ kind: 'red', failingChecks: ['tests'], confirmedLocally: true });
    const events = log.mock.calls.filter((c) => c[0] === 'base_divergence');
    expect(events).toHaveLength(1);
    const msg = String(events[0][1]);
    expect(msg).toContain(SHA);
    expect(msg).toContain('tests');
    expect(msg).toContain('TAIL');
    expect(msg.length).toBeLessThan(1000);
  });

  it('a confirmed SHA is not re-run on the next call', async () => {
    const { cachePath, baselineDeps, runCheckers } = await setup('FAIL', 'boom');
    const confirmed = new Set<string>();
    const o = opts({ baselineDeps, confirmed }, { cachePath, requiredChecksVerdict: green });
    await checkBaseHealth(o);
    const second = await checkBaseHealth(o);
    expect(runCheckers).toHaveBeenCalledTimes(1);
    expect(second).toMatchObject({ kind: 'red', confirmedLocally: true });
    expect(log.mock.calls.filter((c) => c[0] === 'base_divergence')).toHaveLength(1);
  });

  it.each([
    ['not green', async () => ({ green: false, reason: 'pending' })],
    [
      'throwing',
      async (): Promise<{ green: boolean; reason: string }> => {
        throw new Error('boom');
      },
    ],
    ['absent', undefined],
  ])('a cached FAIL with CI %s keeps the cached red and does not re-run', async (_name, requiredChecksVerdict) => {
    const { cachePath, baselineDeps, runCheckers } = await setup('PASS');
    const res = await checkBaseHealth(
      opts({ baselineDeps, confirmed: new Set() }, { cachePath, requiredChecksVerdict }),
    );
    expect(res).toMatchObject({ kind: 'red', failingChecks: ['tests'], cached: true });
    expect(res.confirmedLocally).toBeUndefined();
    expect(runCheckers).not.toHaveBeenCalled();
  });

  it('a fresh re-run error keeps the cached red without confirmedLocally', async () => {
    const { cachePath, baselineDeps, runCheckers } = await setup('PASS', '', 1);
    const res = await checkBaseHealth(
      opts({ baselineDeps, confirmed: new Set() }, { cachePath, requiredChecksVerdict: green }),
    );
    expect(res).toMatchObject({ kind: 'red', failingChecks: ['tests'] });
    expect(res.confirmedLocally).toBeUndefined();
    expect(runCheckers).not.toHaveBeenCalled();
    expect(log.mock.calls.some((c) => c[0] === 'environment_warning' && String(c[1]).includes('fresh re-run'))).toBe(
      true,
    );
  });
});
