import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import { loadFactoryConfig, resolveTimeouts } from '../config/index.js';
import { createTempDirs } from '../harness/temp-dir.js';
import type { EventKind } from '../events/kinds.js';
import type { ModelRouter } from '../router/index.js';
import type { CommandResult } from '../utils/command-runner.js';
import type { BaselineCheckerComparison, BaselineReport, runBaselineCheckers } from './baseline.js';
import { BASE_HEALTH_CHECKERS, checkBaseHealth, type BaseHealthOptions } from './base-health.js';
import { BaselineCache, hashBaselineCheckerConfig, hashBaselineEnv } from './baseline-cache.js';
import { compileChecker, testsChecker, type runAllCheckers } from './index.js';

const SHA = 'b'.repeat(40);
const router = {} as ModelRouter;

function cmd(stdout: string, exitCode = 0): CommandResult {
  return { command: [], stdout, stderr: '', exitCode, killed: false, timedOut: false, ok: exitCode === 0 };
}

const revParse = (stdout = `${SHA}\n`, exitCode = 0) => vi.fn(async () => cmd(stdout, exitCode));

function report(
  verdicts: Partial<Record<string, BaselineCheckerComparison['verdict']>>,
  cached = false,
): BaselineReport {
  return {
    baseSha: SHA,
    checkers: BASE_HEALTH_CHECKERS.map((checker) => ({
      checker,
      verdict: verdicts[checker] ?? 'clean-on-base',
      ...(cached ? { cached: true } : {}),
    })),
  };
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
    router,
    env: { A: '1' },
    log,
    ...extra,
    deps: { memo, runCommand: revParse(), ...deps },
  };
}

const messages = () => log.mock.calls.map((c) => String(c[1]));

describe('checkBaseHealth', () => {
  it('green: runs the three synthetic FAIL checkers on the resolved SHA', async () => {
    const runBaseline = vi.fn<typeof runBaselineCheckers>(async () => report({}));
    const res = await checkBaseHealth(opts({ runBaseline }));
    expect(res).toEqual({ kind: 'green', baseSha: SHA, failingChecks: [], cached: false });
    const arg = runBaseline.mock.calls[0][0];
    expect(arg.baseSha).toBe(SHA);
    expect(arg.failing).toEqual(BASE_HEALTH_CHECKERS.map((checker) => ({ checker, result: 'FAIL', details: '' })));
  });

  it('red: names the checkers that fail on base', async () => {
    const runBaseline = vi.fn<typeof runBaselineCheckers>(async () => report({ tests: 'fails-on-base' }));
    const res = await checkBaseHealth(opts({ runBaseline }));
    expect(res).toMatchObject({ kind: 'red', failingChecks: ['tests'], baseSha: SHA });
    expect(messages().some((m) => m.includes('is red (tests)'))).toBe(true);
  });

  it('a cached tests FAIL on a base whose CI is green is re-run once fresh, not re-held (Breaker, c4069f3f)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'base-health-green-ci-refresh-'));
    try {
      const cachePath = join(dir, 'baseline-cache.json');
      const cache = new BaselineCache(cachePath);
      const env = { A: '1' };
      const envHash = hashBaselineEnv(env);
      const configHash = hashBaselineCheckerConfig(null);
      await cache.set(SHA, envHash, configHash, [
        { checker: 'compile', result: 'PASS', details: 'cached pass' },
        { checker: 'lint', result: 'PASS', details: 'cached pass' },
        { checker: 'tests', result: 'FAIL', details: 'old cached failure' },
      ]);
      const runCheckers = vi.fn<typeof runAllCheckers>(async () => ({
        failures: 0,
        passes: 1,
        skips: 0,
        total: 1,
        results: [{ checker: 'tests', result: 'PASS' as const, details: 'fresh pass' }],
      }));
      const baselineDeps = {
        runCommand: vi.fn(async () => cmd('')),
        runCheckers: runCheckers as never,
        makeTempDir: () => mkdtemp(join(dir, 'worktree-parent-')),
      };
      const result = await checkBaseHealth(
        opts(
          { baselineDeps, memo: new Map() },
          {
            env,
            cachePath,
            requiredChecksVerdict: async () => ({ green: true, reason: 'push CI green' }),
          },
        ),
      );
      expect(result).toMatchObject({ kind: 'green', failingChecks: [] });
      expect(runCheckers).toHaveBeenCalledOnce();
      expect(runCheckers.mock.calls[0][0].worktree).toContain(`${dir}/worktree-parent-`);
      expect(runCheckers.mock.calls[0][4]).toEqual(['tests']);
      expect(await cache.get(SHA, envHash, configHash, 'tests')).toMatchObject({
        result: 'PASS',
        details: 'fresh pass',
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ['non-zero exit', revParse('', 128)],
    ['malformed stdout', revParse('not-a-sha')],
    [
      'a throw',
      vi.fn(async () => {
        throw new Error('spawn');
      }),
    ],
  ])('skips when rev-parse fails (%s)', async (_n, runCommand) => {
    const runBaseline = vi.fn<typeof runBaselineCheckers>();
    const res = await checkBaseHealth(opts({ runBaseline, runCommand }));
    expect(res).toMatchObject({ kind: 'skipped', failingChecks: [], cached: false });
    expect(runBaseline).not.toHaveBeenCalled();
  });

  it('skips on report.error and re-runs on the next call', async () => {
    const runBaseline = vi.fn<typeof runBaselineCheckers>(async () => ({
      baseSha: SHA,
      checkers: [],
      error: 'wt failed',
    }));
    const res = await checkBaseHealth(opts({ runBaseline }));
    expect(res).toMatchObject({ kind: 'skipped', baseSha: SHA, reason: 'wt failed' });
    expect(log.mock.calls.some((c) => c[0] === 'environment_warning')).toBe(true);
    await checkBaseHealth(opts({ runBaseline }));
    expect(runBaseline).toHaveBeenCalledTimes(2);
  });

  it('skips on a rejected baseline run and drops the memo key', async () => {
    const runBaseline = vi.fn<typeof runBaselineCheckers>(async () => {
      throw new Error('kaboom');
    });
    const res = await checkBaseHealth(opts({ runBaseline }));
    expect(res).toMatchObject({ kind: 'skipped', reason: 'kaboom' });
    expect(memo.size).toBe(0);
  });

  it('skips on a non-Error rejection', async () => {
    const runBaseline = vi.fn<typeof runBaselineCheckers>(() => Promise.reject('plain'));
    const res = await checkBaseHealth(opts({ runBaseline }));
    expect(res.reason).toBe('plain');
  });

  it('two lanes on the same base SHA run the baseline checkers once', async () => {
    let release!: (r: BaselineReport) => void;
    const runBaseline = vi.fn<typeof runBaselineCheckers>(
      () => new Promise<BaselineReport>((resolve) => (release = resolve)),
    );
    const log2 = vi.fn<(type: EventKind, msg: string) => void>();
    const first = checkBaseHealth(opts({ runBaseline }));
    const second = checkBaseHealth(opts({ runBaseline }, { log: log2 }));
    await vi.waitFor(() => expect(release).toBeDefined());
    release(report({ lint: 'fails-on-base' }));
    const [a, b] = await Promise.all([first, second]);
    expect(runBaseline).toHaveBeenCalledTimes(1);
    expect(a).toMatchObject({ kind: 'red', cached: false });
    expect(b).toMatchObject({ kind: 'red', cached: true, failingChecks: ['lint'] });
    expect(log2.mock.calls.some((c) => String(c[1]).startsWith('base health: cache hit'))).toBe(true);
  });

  it('logs base health: cache hit when the result is reused', async () => {
    const runBaseline = vi.fn<typeof runBaselineCheckers>(async () => report({}, true));
    const res = await checkBaseHealth(opts({ runBaseline }));
    expect(res.cached).toBe(true);
    expect(messages().some((m) => m.startsWith('base health: cache hit'))).toBe(true);
  });

  it('does not log a cache hit when nothing was reused', async () => {
    await checkBaseHealth(opts({ runBaseline: vi.fn<typeof runBaselineCheckers>(async () => report({})) }));
    expect(messages().some((m) => m.startsWith('base health: cache hit'))).toBe(false);
  });

  it('passes cache: undefined without a cachePath and a BaselineCache with one', async () => {
    const runBaseline = vi.fn<typeof runBaselineCheckers>(async () => report({}));
    await checkBaseHealth(opts({ runBaseline }));
    expect(runBaseline.mock.calls[0][0].cache).toBeUndefined();
    await checkBaseHealth(opts({ runBaseline }, { cachePath: '/tmp/x/cache.json', env: { B: '2' } }));
    expect(runBaseline.mock.calls[1][0].cache).toBeDefined();
  });

  it('does not share the memo across different checker configs (#2563)', async () => {
    const runBaseline = vi.fn<typeof runBaselineCheckers>(async () => report({}));
    const c = (checkers: string[]) => ({
      product: 'p',
      version: 1,
      checkers,
      body: '',
      path: 'c.md',
      source: 'repo' as const,
    });
    await checkBaseHealth(opts({ runBaseline }, { constitution: c(['tests']) }));
    await checkBaseHealth(opts({ runBaseline }, { constitution: c(['tests', 'lint']) }));
    expect(runBaseline).toHaveBeenCalledTimes(2);
  });

  it('uses the real runCommand and module memo by default (non-git dir → skipped)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'base-health-'));
    try {
      const res = await checkBaseHealth({ worktree: dir, constitution: null, router, env: {}, log });
      expect(res.kind).toBe('skipped');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('never throws: an unexpected error returns skipped', async () => {
    log.mockImplementationOnce(() => {
      throw new Error('log broke');
    });
    const res = await checkBaseHealth(opts({ runCommand: revParse('', 1) }));
    expect(res).toMatchObject({ kind: 'skipped', reason: 'log broke' });
  });

  it('a second lane reuses the file-cached base result', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'base-health-cache-'));
    try {
      const runCheckers = vi.fn(async () => ({
        failures: 1,
        passes: 2,
        skips: 0,
        total: 3,
        results: [
          { checker: 'compile', result: 'PASS' as const, details: '' },
          { checker: 'lint', result: 'PASS' as const, details: '' },
          { checker: 'tests', result: 'FAIL' as const, details: 'x' },
        ],
      }));
      const baselineDeps = {
        runCommand: vi.fn(async () => cmd('')),
        runCheckers: runCheckers as never,
        makeTempDir: () => mkdtemp(join(dir, 'p-')),
      };
      const cachePath = join(dir, 'baseline-cache.json');
      const first = await checkBaseHealth(opts({ baselineDeps, memo: new Map() }, { cachePath }));
      const second = await checkBaseHealth(opts({ baselineDeps, memo: new Map() }, { cachePath }));
      expect(runCheckers).toHaveBeenCalledTimes(1);
      expect(first).toMatchObject({ kind: 'red', failingChecks: ['tests'], cached: false });
      expect(second).toMatchObject({ kind: 'red', failingChecks: ['tests'], cached: true });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('checkBaseHealth tests timeout (#3095)', () => {
  /** Runs the real testsChecker on base and returns the timeoutMs its tests command received. */
  async function baseTestsTimeoutMs(testsTimeoutSeconds?: number): Promise<number | undefined> {
    const fixture = await mkdtemp(join(tmpdir(), 'base-health-tests-timeout-'));
    try {
      await writeFile(join(fixture, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));
      const testRun = vi.fn(async (_argv: string[], _opts: { timeoutMs?: number }) => cmd(''));
      const baselineDeps = {
        runCommand: vi.fn(async () => cmd('')),
        runCheckers: (async (ctx: Parameters<typeof testsChecker>[0]) => {
          const out = await testsChecker({ ...ctx, worktree: fixture, runCommand: testRun as never });
          return { failures: 0, passes: 1, skips: 0, total: 1, results: [out] };
        }) as never,
        makeTempDir: () => mkdtemp(join(fixture, 'p-')),
      };
      await checkBaseHealth(opts({ baselineDeps, memo: new Map() }, { testsTimeoutSeconds }));
      const call = testRun.mock.calls.find(([argv]) => argv.includes('test'));
      return call?.[1].timeoutMs;
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  }

  it('runs the base tests command with the configured tests_seconds (600s)', async () => {
    expect(await baseTestsTimeoutMs(600)).toBe(600_000);
  });

  it('FACTORY_TESTS_TIMEOUT (900) wins over tests_seconds (600)', async () => {
    const cfg = loadFactoryConfig();
    const tests = resolveTimeouts(
      { ...cfg, timeouts: { ...cfg.timeouts, tests_seconds: 600 } },
      { FACTORY_TESTS_TIMEOUT: '900' },
    ).tests;
    expect(await baseTestsTimeoutMs(tests)).toBe(900_000);
  });

  it('defaults the base tests command to 300s when nothing is configured', async () => {
    expect(await baseTestsTimeoutMs()).toBe(300_000);
  });
});

afterEach(() => vi.restoreAllMocks());

describe('checkBaseHealth compile timeout (#3186)', () => {
  const tempDirs = createTempDirs();
  afterEach(() => tempDirs.cleanup());

  /** Real compileChecker over a fake runCommand, real BaselineCache in a tmp dir. */
  async function run(compile: { timedOut: boolean }, extra: Partial<BaseHealthOptions>, lintFails = false) {
    const dir = await tempDirs.make('base-health-timeout-');
    await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: { build: 'tsc' } }));
    const buildRun = vi.fn(async () => ({
      ...cmd('', compile.timedOut ? 1 : 2),
      timedOut: compile.timedOut,
      killed: compile.timedOut,
    }));
    const runCheckers = (async (ctx: Parameters<typeof compileChecker>[0]) => {
      const out = await compileChecker({ ...ctx, worktree: dir, runCommand: buildRun as never });
      const lint = { checker: 'lint', result: lintFails ? ('FAIL' as const) : ('PASS' as const), details: 'l' };
      const tests = { checker: 'tests', result: 'PASS' as const, details: '' };
      return { failures: 0, passes: 0, skips: 0, total: 3, results: [out, lint, tests] };
    }) as never;
    const cachePath = join(dir, 'baseline-cache.json');
    const baselineDeps = {
      runCommand: vi.fn(async () => cmd('')),
      runCheckers,
      makeTempDir: () => mkdtemp(join(dir, 'p-')),
    };
    const m = new Map<string, Promise<BaselineReport>>();
    const res = await checkBaseHealth(opts({ baselineDeps, memo: m }, { cachePath, ...extra }));
    const cached = await new BaselineCache(cachePath).get(
      SHA,
      hashBaselineEnv({ A: '1' }),
      hashBaselineCheckerConfig(null),
      'compile',
    );
    return { res, cached, memo: m, dir };
  }

  it('a timed-out base compile with every required check succeeded is green, caches no compile entry and logs the override', async () => {
    const requiredChecksVerdict = vi.fn(async () => ({ green: true, reason: 'all 2 required checks succeeded' }));
    const { res, cached, memo: m, dir } = await run({ timedOut: true }, { requiredChecksVerdict });
    try {
      expect(res).toEqual({ kind: 'green', baseSha: SHA, failingChecks: [], cached: false });
      expect(requiredChecksVerdict).toHaveBeenCalledWith(SHA);
      expect(cached).toBeUndefined();
      expect(m.size).toBe(0);
      expect(messages().some((x) => x.includes(SHA) && x.includes('overriding'))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('a timed-out base compile with a skipped required check is red and awaitingCi', async () => {
    const { res, cached, dir } = await run(
      { timedOut: true },
      { requiredChecksVerdict: async () => ({ green: false, reason: 'ci skipped' }) },
    );
    try {
      expect(res).toMatchObject({ kind: 'red', failingChecks: ['compile'], awaitingCi: true });
      expect(cached).toBeUndefined();
      expect(messages().some((x) => x.includes('ci skipped') && x.includes('holding'))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('a lookup that throws counts as pending: red, awaitingCi, memo entry dropped', async () => {
    const {
      res,
      memo: m,
      dir,
    } = await run(
      { timedOut: true },
      {
        requiredChecksVerdict: async () => {
          throw new Error('offline');
        },
      },
    );
    try {
      expect(res).toMatchObject({ kind: 'red', failingChecks: ['compile'], awaitingCi: true });
      expect(m.size).toBe(0);
      expect(messages().some((x) => x.includes('CI lookup failed: offline'))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('an absent lookup dep counts as CI unknown: red and awaitingCi', async () => {
    const { res, dir } = await run({ timedOut: true }, {});
    try {
      expect(res).toMatchObject({ kind: 'red', failingChecks: ['compile'], awaitingCi: true });
      expect(messages().some((x) => x.includes('CI lookup unavailable'))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('a non-timeout compile failure stays red and never calls the required-checks lookup', async () => {
    const requiredChecksVerdict = vi.fn(async () => ({ green: true, reason: 'ok' }));
    const { res, cached, dir } = await run({ timedOut: false }, { requiredChecksVerdict });
    try {
      expect(res).toMatchObject({ kind: 'red', failingChecks: ['compile'] });
      expect(res.awaitingCi).toBeUndefined();
      expect(requiredChecksVerdict).not.toHaveBeenCalled();
      expect(cached?.result).toBe('FAIL');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('a timed-out compile plus failing lint with CI green is red on lint only, without awaitingCi', async () => {
    const { res, dir } = await run(
      { timedOut: true },
      { requiredChecksVerdict: async () => ({ green: true, reason: 'ok' }) },
      true,
    );
    try {
      expect(res).toMatchObject({ kind: 'red', failingChecks: ['lint'] });
      expect(res.awaitingCi).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('a timed-out compile plus failing lint with CI not green is red without awaitingCi', async () => {
    const { res, dir } = await run(
      { timedOut: true },
      { requiredChecksVerdict: async () => ({ green: false, reason: 'x' }) },
      true,
    );
    try {
      expect(res).toMatchObject({ kind: 'red', failingChecks: ['compile', 'lint'] });
      expect(res.awaitingCi).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
