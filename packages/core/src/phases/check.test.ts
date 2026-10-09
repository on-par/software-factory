import { execFile as execFileCb } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { LaneLifecycleEventSchema } from '@on-par/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createLifecycleBus } from '../bus/index.js';
import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { ModelRouter } from '../router/index.js';
import { StubModelExecutor } from '../router/stub.js';
import type { SandboxPolicy } from '../sandbox/index.js';
import type { BaselineReport } from '../checkers/baseline.js';
import { BaselineCache } from '../checkers/baseline-cache.js';
import type { CheckSummary, Constitution, ReworkInfo } from '../types/index.js';
import {
  baseFailingCheckers,
  checkPhase,
  type EnvironmentFailure,
  excludeBaseFailing,
  environmentLogPaths,
  isEnvironmentFailure,
  markTestsFlaky,
  LENS_REVIEW_CHECKER,
  lensShowstopperRefs,
  remainingShowstoppers,
  renderEnvironmentReleaseComment,
  stuckSignature,
} from './check.js';

const models: ModelsConfig = {
  version: 1,
  models: {
    'stub-model': {
      provider: 'openai',
      tier: 'boss',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
    },
  },
  tiers: { boss: ['stub-model'] },
  failover: {
    triggers: ['rate_limit', 'usage_cap', 'timeout', 'error', 'empty_response'],
    maxRetries: 2,
    cooldownMs: 0,
    escalateAfterTierExhausted: true,
  },
  routingRules: {},
};

const routes: RoutesConfig = {
  version: 1,
  routes: {
    build_claude: { tier: 'boss', description: 'stub' },
  },
};

const codexModels: ModelsConfig = {
  ...models,
  models: {
    'codex-worker': {
      provider: 'openai',
      tier: 'boss',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: ['codex'],
      envKey: null,
      codex: true,
    },
    'claude-worker': {
      provider: 'anthropic',
      tier: 'boss',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: ['claude'],
      envKey: null,
    },
  },
  tiers: { boss: ['codex-worker', 'claude-worker'] },
};

const codexRoutes: RoutesConfig = {
  version: 1,
  routes: {
    build_codex: { tier: 'boss', description: 'codex', requires: 'codex' },
    build_claude: { tier: 'boss', description: 'claude', requires: 'claude' },
  },
};

const execFile = promisify(execFileCb);

const twoModels: ModelsConfig = {
  ...models,
  models: {
    ...models.models,
    'second-model': {
      provider: 'custom',
      tier: 'boss',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
    },
  },
  tiers: { boss: ['stub-model', 'second-model'] },
};

const tempDirs = new Set<string>();

afterEach(async () => {
  await Promise.all([...tempDirs].map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.clear();
});

describe('partial base overlap (#1929)', () => {
  const summaryOf = (...results: Array<[string, 'PASS' | 'FAIL']>): CheckSummary => ({
    results: results.map(([checker, result]) => ({
      checker,
      result,
      details: result === 'FAIL' ? `${checker === 'tests' ? 'a' : 'b'} broke` : '',
    })),
    failures: results.filter(([, r]) => r === 'FAIL').length,
    passes: results.filter(([, r]) => r === 'PASS').length,
    skips: 0,
    total: results.length,
  });
  const reportOf = (...entries: Array<[string, 'clean-on-base' | 'fails-on-base' | 'not-run']>): BaselineReport => ({
    baseSha: 'abc1234567',
    checkers: entries.map(([checker, verdict]) => ({ checker, verdict })),
  });
  const partialBaseline = async (o: { baseSha: string }) =>
    ({
      baseSha: o.baseSha,
      checkers: [
        { checker: 'tests', verdict: 'fails-on-base', baseResult: 'FAIL' },
        { checker: 'lint', verdict: 'clean-on-base', baseResult: 'PASS' },
      ],
    }) as BaselineReport;

  const makePartialWorktree = async () => {
    const { worktree, specPath } = await makeFailingWorktree();
    await writeFile(join(worktree, 'package.json'), JSON.stringify({ scripts: { test: 'exit 1', lint: 'exit 1' } }));
    return { worktree, specPath };
  };

  describe('baseFailingCheckers', () => {
    it('returns fails-on-base checkers only', () => {
      expect(baseFailingCheckers(reportOf(['tests', 'fails-on-base'], ['lint', 'clean-on-base']))).toEqual(
        new Set(['tests']),
      );
    });

    it('is empty without a usable baseline, or for not-run and clean-on-base entries', () => {
      expect(baseFailingCheckers(undefined).size).toBe(0);
      expect(baseFailingCheckers({ baseSha: 'abc1234567', checkers: [], error: 'boom' }).size).toBe(0);
      expect(baseFailingCheckers(reportOf(['tests', 'not-run'], ['lint', 'clean-on-base'])).size).toBe(0);
    });

    it('keeps a checker with new failing tests, and includes one with an empty list', () => {
      const report = (newFailingTests: string[]): BaselineReport => ({
        baseSha: 'abc1234567',
        checkers: [{ checker: 'tests', verdict: 'fails-on-base', newFailingTests }],
      });
      expect(baseFailingCheckers(report(['x'])).size).toBe(0);
      expect(baseFailingCheckers(report([]))).toEqual(new Set(['tests']));
    });
  });

  describe('excludeBaseFailing', () => {
    it('drops only the excluded FAIL result and recomputes failures and total', () => {
      const out = excludeBaseFailing(
        summaryOf(['tests', 'FAIL'], ['lint', 'FAIL'], ['types', 'PASS']),
        new Set(['tests']),
      );
      expect(out.results.map((r) => r.checker)).toEqual(['lint', 'types']);
      expect(out.failures).toBe(1);
      expect(out.total).toBe(2);
      expect(out.passes).toBe(1);
    });

    it('keeps PASS results of an excluded checker', () => {
      const out = excludeBaseFailing(summaryOf(['tests', 'PASS'], ['lint', 'FAIL']), new Set(['tests']));
      expect(out.results.map((r) => r.checker)).toEqual(['tests', 'lint']);
    });

    it('returns the same reference when the set is empty', () => {
      const summary = summaryOf(['tests', 'FAIL']);
      expect(excludeBaseFailing(summary, new Set())).toBe(summary);
    });
  });

  describe('stuckSignature', () => {
    const both = summaryOf(['tests', 'FAIL'], ['lint', 'FAIL']);

    it('excludes base-failing checkers and keeps the rest', () => {
      const sig = stuckSignature(both, new Set(['tests']));
      expect(sig).toContain('lint:');
      expect(sig).not.toContain('tests:');
    });

    it('is the full signature with an empty set', () => {
      const sig = stuckSignature(both, new Set());
      expect(sig).toContain('lint:');
      expect(sig).toContain('tests:');
    });

    it('falls back to the full non-empty signature when only base-failing checkers fail', () => {
      const sig = stuckSignature(summaryOf(['tests', 'FAIL']), new Set(['tests']));
      expect(sig).toContain('tests:');
    });
  });

  const heldRun = async (priorFailureSignature: string) => {
    const { worktree, specPath } = await makePartialWorktree();
    const { router, stub } = makeRouter();
    const result = await checkPhase({
      issue: 1929,
      worktree,
      specPath,
      router,
      constitution: null,
      maxReworkRounds: 1,
      diffBase: 'abc1234567',
      priorFailureSignature,
      log: () => {},
      runBaseline: partialBaseline,
    });
    return { result, stub };
  };

  it('cross-run held matches the filtered or the full unfiltered signature', { timeout: 120_000 }, async () => {
    const first = await heldRun('never-matches');
    expect(first.result.failureSignature).toContain('lint:');
    expect(first.result.failureSignature).not.toContain('tests:');

    const filtered = await heldRun(first.result.failureSignature as string);
    expect(filtered.result.crossRunStuck).toBe(true);
    expect(filtered.stub.calls).toHaveLength(0);

    const full = stuckSignature(first.result.summary, new Set());
    expect(full).toContain('tests:');
    const unfiltered = await heldRun(full);
    expect(unfiltered.result.crossRunStuck).toBe(true);
    expect(unfiltered.stub.calls).toHaveLength(0);
  });

  it('rework prompt and signature target only the lane-owned checker', { timeout: 120_000 }, async () => {
    const { worktree, specPath } = await makePartialWorktree();
    const { router, stub } = makeRouter();
    const seen: string[][] = [];
    const result = await checkPhase({
      issue: 1929,
      worktree,
      specPath,
      router,
      constitution: null,
      maxReworkRounds: 1,
      diffBase: 'abc1234567',
      log: () => {},
      runBaseline: async (o) => {
        seen.push(o.failing.filter((r) => r.result === 'FAIL').map((r) => r.checker));
        return partialBaseline(o);
      },
    });
    expect(seen[0]).toEqual(expect.arrayContaining(['tests', 'lint']));
    expect(stub.calls.length).toBeGreaterThanOrEqual(1);
    expect(result.reworkRounds).toBe(1);
    expect(result.environment).toBeUndefined();
    expect(stub.calls[0].prompt).toContain('### lint');
    expect(stub.calls[0].prompt).not.toContain('### tests');
    expect(result.failureSignature).toContain('lint:');
    expect(result.failureSignature).not.toContain('tests:');
  });

  it('stops rework when only base-failing checkers remain', { timeout: 120_000 }, async () => {
    const { worktree, specPath } = await makePartialWorktree();
    let calls = 0;
    const fakeRouter = {
      run: async () => {
        calls++;
        await writeFile(
          join(worktree, 'package.json'),
          JSON.stringify({ scripts: { test: 'exit 1', lint: 'exit 0' } }),
        );
        return { model: 'fake-model', output: 'done', exitCode: 0, attempts: [] };
      },
    } as any;
    const messages: string[] = [];
    const result = await checkPhase({
      issue: 1929,
      worktree,
      specPath,
      router: fakeRouter,
      constitution: null,
      maxReworkRounds: 2,
      diffBase: 'abc1234567',
      log: (_type, msg) => messages.push(msg),
      runBaseline: partialBaseline,
    });
    expect(calls).toBe(1);
    expect(messages.some((m) => m.includes('only base-failing checkers remain'))).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.failureSignature).toContain('tests:');
  });
});

describe('rework cause environment (#1927)', () => {
  const summaryOf = (...results: Array<[string, 'PASS' | 'FAIL']>): CheckSummary => ({
    results: results.map(([checker, result]) => ({ checker, result, details: '' })),
    failures: results.filter(([, r]) => r === 'FAIL').length,
    passes: results.filter(([, r]) => r === 'PASS').length,
    skips: 0,
    total: results.length,
  });
  const reportOf = (...entries: Array<[string, 'clean-on-base' | 'fails-on-base' | 'not-run']>): BaselineReport => ({
    baseSha: 'abc1234567',
    checkers: entries.map(([checker, verdict]) => ({ checker, verdict })),
  });

  it('is true when every failing checker fails on base', () => {
    expect(isEnvironmentFailure(summaryOf(['tests', 'FAIL']), reportOf(['tests', 'fails-on-base']))).toBe(true);
    expect(
      isEnvironmentFailure(
        summaryOf(['tests', 'FAIL'], ['lint', 'FAIL']),
        reportOf(['tests', 'fails-on-base'], ['lint', 'fails-on-base']),
      ),
    ).toBe(true);
  });

  it('ignores baseline entries for checkers that did not fail', () => {
    expect(
      isEnvironmentFailure(
        summaryOf(['tests', 'FAIL'], ['lint', 'PASS']),
        reportOf(['tests', 'fails-on-base'], ['lint', 'clean-on-base']),
      ),
    ).toBe(true);
  });

  it('is false without a usable baseline', () => {
    expect(isEnvironmentFailure(summaryOf(['tests', 'FAIL']), undefined)).toBe(false);
    expect(
      isEnvironmentFailure(summaryOf(['tests', 'FAIL']), { baseSha: 'abc1234567', checkers: [], error: 'boom' }),
    ).toBe(false);
  });

  it('is false on partial overlap, not-run, or a missing checker', () => {
    const failing = summaryOf(['tests', 'FAIL'], ['lint', 'FAIL']);
    expect(isEnvironmentFailure(failing, reportOf(['tests', 'fails-on-base'], ['lint', 'clean-on-base']))).toBe(false);
    expect(isEnvironmentFailure(failing, reportOf(['tests', 'fails-on-base'], ['lint', 'not-run']))).toBe(false);
    expect(isEnvironmentFailure(failing, reportOf(['tests', 'fails-on-base']))).toBe(false);
  });

  it('is false when nothing failed', () => {
    expect(isEnvironmentFailure(summaryOf(['tests', 'PASS']), reportOf(['tests', 'fails-on-base']))).toBe(false);
  });

  const runWithVerdict = async (
    verdict: 'fails-on-base' | 'clean-on-base',
    extra: { logsDir?: string; priorFailureSignature?: string } = {},
  ) => {
    const { worktree, specPath } = await makeFailingWorktree();
    const { router, stub } = makeRouter();
    const order: string[] = [];
    const reworks: ReworkInfo[] = [];
    const kinds: string[] = [];
    const result = await checkPhase({
      ...extra,
      issue: 77,
      worktree,
      specPath,
      router,
      constitution: null,
      maxReworkRounds: 1,
      diffBase: 'abc1234567',
      log: (type, _msg, logExtra) => {
        kinds.push(type);
        if (type === 'rework' && logExtra?.rework) {
          order.push('rework');
          reworks.push(logExtra.rework);
        }
      },
      runBaseline: async (o) => {
        order.push('baseline');
        return {
          baseSha: o.baseSha,
          checkers: o.failing
            .filter((r) => r.result === 'FAIL')
            .map((r) => ({ checker: r.checker, verdict, baseResult: verdict === 'fails-on-base' ? 'FAIL' : 'PASS' })),
        } as BaselineReport;
      },
    });
    return { order, reworks, result, kinds, stub };
  };

  it(
    'skips rework and returns an environment failure when every failing checker fails on base (#1928)',
    { timeout: 120_000 },
    async () => {
      const { reworks, result, stub } = await runWithVerdict('fails-on-base');
      expect(reworks).toEqual([]);
      expect(stub.calls).toHaveLength(0);
      expect(result.reworkRounds).toBe(0);
      expect(result.passed).toBe(false);
      expect(result.environment).toEqual({
        baseSha: 'abc1234567',
        failingChecks: expect.any(Array),
        logPaths: [],
      });
      expect(result.environment?.failingChecks.length).toBeGreaterThan(0);
    },
  );

  it(
    'includes the round-1 full-output log and the base log dir in logPaths (#1928)',
    { timeout: 120_000 },
    async () => {
      const logsDir = await mkdtemp(join(tmpdir(), 'check-env-logs-'));
      tempDirs.add(logsDir);
      const { result } = await runWithVerdict('fails-on-base', { logsDir });
      const paths = result.environment?.logPaths ?? [];
      expect(paths.some((p) => p.startsWith(join(logsDir, 'issue-77', 'check-r0')))).toBe(true);
      expect(paths).toContain(join(logsDir, 'issue-77', 'check-base'));
    },
  );

  it('environment wins over a matching priorFailureSignature (#1928)', { timeout: 120_000 }, async () => {
    const first = await runWithVerdict('fails-on-base');
    const { result, kinds } = await runWithVerdict('fails-on-base', {
      priorFailureSignature: first.result.failureSignature,
    });
    expect(kinds).not.toContain('held');
    expect(result.crossRunStuck).toBeUndefined();
    expect(result.environment).toBeDefined();
  });

  describe('environmentLogPaths / renderEnvironmentReleaseComment (#1928)', () => {
    const failing = (checker: string, details: string) => ({ checker, result: 'FAIL' as const, details });
    const sum = (results: CheckSummary['results']): CheckSummary => ({
      results,
      failures: results.filter((r) => r.result === 'FAIL').length,
      passes: 0,
      skips: 0,
      total: results.length,
    });

    it('collects full-output paths from FAIL results, dedupes, ignores PASS, appends the base dir', () => {
      const summary = sum([
        failing('tests', 'exit 1\nfull output: /logs/a.log'),
        failing('lint', 'x\nfull output: /logs/b.log\nfull output: /logs/a.log'),
        { checker: 'types', result: 'PASS', details: 'full output: /logs/pass.log' },
      ]);
      expect(environmentLogPaths(summary, '/logs/check-base')).toEqual([
        '/logs/a.log',
        '/logs/b.log',
        '/logs/check-base',
      ]);
      expect(environmentLogPaths(summary, undefined)).toEqual(['/logs/a.log', '/logs/b.log']);
    });

    it('renders checkers, the full SHA and every path', () => {
      const failure: EnvironmentFailure = {
        baseSha: 'abc1234567890def',
        failingChecks: ['tests', 'lint'],
        logPaths: ['/logs/a.log', '/logs/check-base'],
      };
      const body = renderEnvironmentReleaseComment(failure);
      for (const needle of ['`tests`', '`lint`', 'abc1234567890def', '/logs/a.log', '/logs/check-base']) {
        expect(body).toContain(needle);
      }
      expect(body).not.toContain('No log paths were recorded');
    });

    it('says so when no log paths were recorded', () => {
      expect(renderEnvironmentReleaseComment({ baseSha: 'abc', failingChecks: ['tests'], logPaths: [] })).toContain(
        'No log paths were recorded (logsDir not set).',
      );
    });
  });

  it('keeps factory-fault when the base is clean', { timeout: 120_000 }, async () => {
    const { reworks } = await runWithVerdict('clean-on-base');
    expect(reworks.length).toBeGreaterThan(0);
    expect(reworks.every((r) => r.cause === 'factory-fault')).toBe(true);
  });
});

describe('checkPhase baseline (#1925)', () => {
  const cleanReport = (baseSha: string): BaselineReport => ({
    baseSha,
    checkers: [{ checker: 'tests', verdict: 'clean-on-base', baseResult: 'PASS' }],
  });

  it('does not call the baseline when round 1 passes', { timeout: 120_000 }, async () => {
    const { worktree, specPath } = await makePassingWorktree();
    const { router } = makeRouter();
    const calls: unknown[] = [];
    const result = await checkPhase({
      issue: 1,
      worktree,
      specPath,
      router,
      constitution: null,
      log: () => {},
      diffBase: 'abc12345',
      runBaseline: async (o) => {
        calls.push(o);
        return cleanReport(o.baseSha);
      },
    });
    expect(calls).toHaveLength(0);
    expect(result.baseline).toBeUndefined();
  });

  it('reports a clean base without changing the outcome', { timeout: 120_000 }, async () => {
    const { worktree, specPath } = await makeFailingWorktree();
    const { router } = makeRouter();
    const baseOpts = { issue: 77, worktree, specPath, router, constitution: null, autoRework: false };
    const without = await checkPhase({ ...baseOpts, log: () => {} });

    const logs: string[] = [];
    const calls: any[] = [];
    const result = await checkPhase({
      ...baseOpts,
      log: (type, msg) => {
        if (type === 'check') logs.push(msg);
      },
      diffBase: 'abc1234567',
      runBaseline: async (o) => {
        calls.push(o);
        return cleanReport(o.baseSha);
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].baseSha).toBe('abc1234567');
    expect(calls[0].laneWorktree).toBe(worktree);
    expect(calls[0].ctx.env).toEqual(calls[0].ctx.env);
    expect(calls[0].ctx.env).toBeDefined();
    expect(result.baseline).toEqual(cleanReport('abc1234567'));
    expect(result.passed).toBe(without.passed);
    expect(result.reworkRounds).toBe(without.reworkRounds);
    expect(result.failureSignature).toBe(without.failureSignature);
    expect(logs.some((m) => m.includes('clean on base'))).toBe(true);
  });

  it('logs when a checker also fails on base', { timeout: 120_000 }, async () => {
    const { worktree, specPath } = await makeFailingWorktree();
    const { router } = makeRouter();
    const logs: string[] = [];
    await checkPhase({
      issue: 77,
      worktree,
      specPath,
      router,
      constitution: null,
      autoRework: false,
      log: (type, msg) => {
        if (type === 'check') logs.push(msg);
      },
      diffBase: 'abc1234567',
      runBaseline: async (o) => ({
        baseSha: o.baseSha,
        checkers: [
          {
            checker: 'tests',
            verdict: 'fails-on-base',
            baseResult: 'FAIL',
            sharedFailingTests: ['a'],
            newFailingTests: ['b'],
          },
        ],
      }),
    });
    expect(logs.some((m) => m.includes('tests also fails on base (1 shared, 1 new failing tests)'))).toBe(true);
  });

  it('passes a BaselineCache only when baselineCachePath is set (#1926)', { timeout: 120_000 }, async () => {
    const { worktree, specPath } = await makeFailingWorktree();
    const { router } = makeRouter();
    const caches: unknown[] = [];
    const base = {
      issue: 77,
      worktree,
      specPath,
      router,
      constitution: null,
      autoRework: false,
      diffBase: 'abc1234567',
    };
    const runBaseline = async (o: any) => {
      caches.push(o.cache);
      return cleanReport(o.baseSha);
    };
    await checkPhase({ ...base, log: () => {}, runBaseline });
    await checkPhase({ ...base, log: () => {}, runBaseline, baselineCachePath: join(worktree, 'bc.json') });
    expect(caches[0]).toBeUndefined();
    expect(caches[1]).toBeInstanceOf(BaselineCache);
  });

  it('marks cached baseline entries in the log (#1926)', { timeout: 120_000 }, async () => {
    const { worktree, specPath } = await makeFailingWorktree();
    const { router } = makeRouter();
    const logs: string[] = [];
    await checkPhase({
      issue: 77,
      worktree,
      specPath,
      router,
      constitution: null,
      autoRework: false,
      log: (type, msg) => {
        if (type === 'check') logs.push(msg);
      },
      diffBase: 'abc1234567',
      runBaseline: async (o) => ({
        baseSha: o.baseSha,
        checkers: [{ checker: 'tests', verdict: 'clean-on-base', baseResult: 'PASS', cached: true }],
      }),
    });
    expect(logs.some((m) => m.includes('tests clean on base (cached)'))).toBe(true);
  });

  it('runs the baseline once even when rework rounds happen', { timeout: 120_000 }, async () => {
    const { worktree, specPath } = await makeFailingWorktree();
    const { router } = makeRouter();
    let calls = 0;
    const result = await checkPhase({
      issue: 77,
      worktree,
      specPath,
      router,
      constitution: null,
      log: () => {},
      maxReworkRounds: 2,
      diffBase: 'abc1234567',
      runBaseline: async (o) => {
        calls++;
        return cleanReport(o.baseSha);
      },
    });
    expect(result.reworkRounds).toBeGreaterThan(0);
    expect(calls).toBe(1);
  });

  it('survives a rejecting baseline and records the error', { timeout: 120_000 }, async () => {
    const { worktree, specPath } = await makeFailingWorktree();
    const { router } = makeRouter();
    const result = await checkPhase({
      issue: 77,
      worktree,
      specPath,
      router,
      constitution: null,
      log: () => {},
      autoRework: false,
      diffBase: 'abc1234567',
      runBaseline: async () => {
        throw new Error('boom');
      },
    });
    expect(result.passed).toBe(false);
    expect(result.baseline?.error).toBe('boom');
  });

  it('skips the baseline when diffBase is undefined', { timeout: 120_000 }, async () => {
    const { worktree, specPath } = await makeFailingWorktree();
    const { router } = makeRouter();
    const logs: string[] = [];
    let calls = 0;
    const result = await checkPhase({
      issue: 77,
      worktree,
      specPath,
      router,
      constitution: null,
      autoRework: false,
      log: (_t, msg) => logs.push(msg),
      runBaseline: async (o) => {
        calls++;
        return cleanReport(o.baseSha);
      },
    });
    expect(calls).toBe(0);
    expect(result.baseline).toBeUndefined();
    expect(logs.some((m) => m.includes('baseline skipped'))).toBe(true);
  });
});

describe('checkPhase auto rework', () => {
  it('uses the completed Codex route and model for rework', { timeout: 120_000 }, async () => {
    const { worktree, specPath } = await makeFailingWorktree();
    const stub = new StubModelExecutor({ scripts: { build_codex: [{ output: 'rework complete' }] } });
    const router = new ModelRouter(codexModels, codexRoutes, false, stub);

    await checkPhase({
      issue: 817,
      worktree,
      specPath,
      router,
      constitution: null,
      log: () => {},
      maxReworkRounds: 1,
      reworkRoute: 'codex',
      reworkModel: 'codex-worker',
    });

    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]).toMatchObject({ task: 'build_codex', model: 'codex-worker' });
    expect(stub.calls.some((call) => call.task === 'build_claude')).toBe(false);
  });

  it('threads the per-run id into the rework worker env (#1910)', { timeout: 120_000 }, async () => {
    const { worktree, specPath } = await makeFailingWorktree();
    await writeFile(join(worktree, 'App.sln'), '');
    const envs: unknown[] = [];
    const fakeRouter = {
      run: async (_task: string, _prompt: string, options: { env?: unknown }) => {
        envs.push(options.env);
        return { model: 'fake-model', output: 'done', exitCode: 0, attempts: [] };
      },
    } as any;

    await checkPhase({
      issue: 1910,
      worktree,
      specPath,
      router: fakeRouter,
      constitution: null,
      log: () => {},
      maxReworkRounds: 1,
      runId: 'r1',
    });

    expect(envs).toHaveLength(1);
    expect(envs[0]).toMatchObject({ SharedCompilationId: 'factory-r1', MSBUILDDISABLENODEREUSE: '1' });
  });

  it('parks before rework when a collectable worker diff is empty', { timeout: 120_000 }, async () => {
    const { worktree, specPath } = await makeCleanGitWorktree();
    const { router, stub } = makeRouter();
    const logs: Array<{ type: string; msg: string }> = [];

    const check = await checkPhase({
      issue: 817,
      worktree,
      specPath,
      router,
      constitution: null,
      log: (type, msg) => logs.push({ type, msg }),
    });

    expect(check.passed).toBe(false);
    expect(check.reworkRounds).toBe(0);
    expect(check.failureSignature).toContain('worker_output:worker produced no diff');
    expect(stub.calls).toHaveLength(0);
    expect(logs).toContainEqual({
      type: 'fail',
      msg: 'worker produced no implementation diff — parking before rework',
    });
  });

  it(
    'parks before rework in a remote-less checkout when nothing changed since the run-start base',
    { timeout: 120_000 },
    async () => {
      const { worktree, specPath, baseSha } = await makeRemoteLessGitWorktree();
      const { router, stub } = makeRouter();

      const check = await checkPhase({
        issue: 1211,
        worktree,
        specPath,
        router,
        constitution: null,
        log: () => {},
        diffBase: baseSha,
      });

      expect(check.passed).toBe(false);
      expect(check.reworkRounds).toBe(0);
      expect(check.failureSignature).toContain('worker_output:worker produced no diff');
      expect(stub.calls).toHaveLength(0);
    },
  );

  it('does not re-invoke the worker when auto rework is disabled', { timeout: 120_000 }, async () => {
    const { worktree, specPath } = await makeFailingWorktree();
    const { router, stub } = makeRouter();
    const constitution = null;
    const log = () => {};

    const check = await checkPhase({
      issue: 77,
      worktree,
      specPath,
      router,
      constitution,
      log,
      autoRework: false,
    });

    expect(check.passed).toBe(false);
    expect(check.reworkRounds).toBe(0);
    expect(stub.calls).toHaveLength(0);
  });

  it('stops after the configured single targeted repair pass', { timeout: 120_000 }, async () => {
    const { worktree, specPath } = await makeFailingWorktree();
    const { router, stub } = makeRouter();

    const check = await checkPhase({
      issue: 77,
      worktree,
      specPath,
      router,
      constitution: null,
      log: () => {},
      maxReworkRounds: 1,
    });

    expect(check.passed).toBe(false);
    expect(check.reworkRounds).toBe(1);
    expect(stub.calls).toHaveLength(1);
  });

  it(
    "writes each round's failing checker output under logsDir and points the rework prompt at it",
    { timeout: 120_000 },
    async () => {
      const { worktree, specPath } = await makeFailingWorktree();
      const logsDir = await mkdtemp(join(tmpdir(), 'check-phase-logs-'));
      tempDirs.add(logsDir);
      const { router, stub } = makeRouter();

      const check = await checkPhase({
        issue: 77,
        worktree,
        specPath,
        router,
        constitution: null,
        log: () => {},
        maxReworkRounds: 1,
        logsDir,
      });

      const round0 = join(logsDir, 'issue-77', 'check-r0', 'tests-npm-test.log');
      const round1 = join(logsDir, 'issue-77', 'check-r1', 'tests-npm-test.log');
      await expect(readFile(round0, 'utf8')).resolves.toContain('$ npm test');
      await expect(readFile(round1, 'utf8')).resolves.toContain('$ npm test');
      expect(stub.calls[0]?.prompt).toContain(`full output: ${round0}`);
      expect(stub.calls[0]?.prompt).toContain('read that file first');
      expect(check.summary.results.find((r) => r.checker === 'tests')?.details).toContain(`full output: ${round1}`);
    },
  );

  it('captures .NET failed-test identifiers in the rework event', { timeout: 120_000 }, async () => {
    const worktree = await makeWorktreeWithFiles(78, {
      'package.json': JSON.stringify({
        scripts: { test: `node -e "console.log('failed Ns.ClassTests.ShouldWork (46ms)'); process.exit(1)"` },
      }),
    });
    const { router } = makeRouter();
    const reworks: ReworkInfo[] = [];

    await checkPhase({
      issue: 78,
      worktree,
      specPath: join(worktree, 'issue-78.md'),
      router,
      constitution: null,
      log: (type, _msg, extra) => {
        if (type === 'rework' && extra?.rework) reworks.push(extra.rework);
      },
      maxReworkRounds: 1,
    });

    expect(reworks[0]?.failingTests).toEqual(['Ns.ClassTests.ShouldWork']);
  });

  it('keeps the existing rework behavior by default', { timeout: 120_000 }, async () => {
    const { worktree, specPath } = await makeFailingWorktree();
    const { router, stub } = makeRouter();
    const constitution = null;
    const log = () => {};

    const check = await checkPhase({
      issue: 77,
      worktree,
      specPath,
      router,
      constitution,
      log,
    });

    expect(check.passed).toBe(false);
    expect(check.reworkRounds).toBe(2);
    expect(stub.calls).toHaveLength(2);
    expect(check.stuck).toBe(true);
  });

  it(
    'emits a stuck event once identical failures repeat across consecutive rework rounds',
    { timeout: 120_000 },
    async () => {
      const { worktree, specPath } = await makeFailingWorktree();
      const { router } = makeRouter();
      const logCalls: Array<[string, string, ({ rework?: ReworkInfo } | undefined)?]> = [];

      await checkPhase({
        issue: 77,
        worktree,
        specPath,
        router,
        constitution: null,
        log: (type, msg, extra) => {
          logCalls.push([type, msg, extra]);
        },
      });

      const stuckCalls = logCalls.filter(([type]) => type === 'stuck');
      expect(stuckCalls).toHaveLength(1);
      const rework = stuckCalls[0][2]?.rework;
      expect(rework?.stuck).toBe(true);
      expect(rework?.cause).toBe('factory-fault');
      expect(rework?.failingChecks.length).toBeGreaterThan(0);
    },
  );

  it(
    "skips the rework loop entirely and reports crossRunStuck when round one matches a prior run's failure signature (#740)",
    { timeout: 120_000 },
    async () => {
      // First run establishes what signature this fixture produces (no priorFailureSignature yet).
      const first = await makeFailingWorktree();
      const baseline = await checkPhase({
        issue: 77,
        worktree: first.worktree,
        specPath: first.specPath,
        router: makeRouter().router,
        constitution: null,
        log: () => {},
        maxReworkRounds: 1,
      });
      expect(baseline.failureSignature).toBeDefined();

      // A fresh "run" (fresh worktree, fresh router/stub) hits the identical failure
      // on round one — simulates a watchdog relaunch walking back into the same lane.
      const second = await makeFailingWorktree();
      const { router, stub } = makeRouter();
      const logCalls: Array<[string, string, ({ rework?: ReworkInfo } | undefined)?]> = [];

      const check = await checkPhase({
        issue: 77,
        worktree: second.worktree,
        specPath: second.specPath,
        router,
        constitution: null,
        log: (type, msg, extra) => {
          logCalls.push([type, msg, extra]);
        },
        priorFailureSignature: baseline.failureSignature,
      });

      expect(check.passed).toBe(false);
      expect(check.stuck).toBe(true);
      expect(check.crossRunStuck).toBe(true);
      expect(check.reworkRounds).toBe(0);
      // No rework budget burned: the worker was never invoked this run.
      expect(stub.calls).toHaveLength(0);

      const heldCalls = logCalls.filter(([type]) => type === 'held');
      expect(heldCalls).toHaveLength(1);
      expect(heldCalls[0][2]?.rework?.round).toBe(0);
      expect(heldCalls[0][2]?.rework?.stuck).toBe(true);
      expect(heldCalls[0][2]?.rework?.failingChecks.length).toBeGreaterThan(0);
    },
  );

  it(
    "runs the normal rework loop when priorFailureSignature does not match this run's failure (#740)",
    { timeout: 120_000 },
    async () => {
      const { worktree, specPath } = await makeFailingWorktree();
      const { router, stub } = makeRouter();

      const check = await checkPhase({
        issue: 77,
        worktree,
        specPath,
        router,
        constitution: null,
        log: () => {},
        priorFailureSignature: 'a-signature-this-run-does-not-produce',
      });

      expect(check.crossRunStuck).toBeFalsy();
      expect(check.reworkRounds).toBeGreaterThan(0);
      expect(stub.calls.length).toBeGreaterThan(0);
    },
  );

  it('emits a rework event carrying structured cause metadata', { timeout: 120_000 }, async () => {
    const { worktree, specPath } = await makeFailingWorktree();
    const { router } = makeRouter();
    const logCalls: Array<[string, string, ({ rework?: ReworkInfo } | undefined)?]> = [];

    await checkPhase({
      issue: 77,
      worktree,
      specPath,
      router,
      constitution: null,
      log: (type, msg, extra) => {
        logCalls.push([type, msg, extra]);
      },
    });

    const reworkCalls = logCalls.filter(([type]) => type === 'rework');
    expect(reworkCalls.length).toBeGreaterThan(0);
    const first = reworkCalls[0];
    expect(first[2]?.rework?.round).toBe(1);
    expect(first[2]?.rework?.cause).toBe('factory-fault');
    expect(first[2]?.rework?.failingChecks.length).toBeGreaterThan(0);
  });

  it('captures bounded test identifiers and output in rework and stuck events', { timeout: 120_000 }, async () => {
    const { worktree, specPath } = await makeTestFailureEvidenceWorktree();
    const { router } = makeRouter();
    const logCalls: Array<[string, string, { rework?: ReworkInfo } | undefined]> = [];

    await checkPhase({
      issue: 491,
      worktree,
      specPath,
      router,
      constitution: null,
      log: (type, msg, extra) => {
        logCalls.push([type, msg, extra]);
      },
    });

    const rework = logCalls.find(([type]) => type === 'rework')?.[2]?.rework;
    expect(rework).toMatchObject({
      cause: 'factory-fault',
      failingTests: [
        'src/phases/build.test.ts > buildPhase > uses the Codex route',
        'reports the fallback warning',
        'restores the inherited environment',
      ],
    });
    expect(rework?.failureOutput).toContain('FAIL  src/phases/build.test.ts > buildPhase > uses the Codex route');
    expect(rework?.failureOutput?.length).toBeLessThanOrEqual(400);

    const stuck = logCalls.find(([type]) => type === 'stuck')?.[2]?.rework;
    expect(stuck?.failingTests).toEqual(rework?.failingTests);
    expect(stuck?.failureOutput).toBe(rework?.failureOutput);
  });

  it('does not invent test evidence for non-test checker failures', { timeout: 120_000 }, async () => {
    const { worktree, specPath } = await makeLintFailingWorktree();
    const { router } = makeRouter();
    const logCalls: Array<[string, string, { rework?: ReworkInfo } | undefined]> = [];

    await checkPhase({
      issue: 492,
      worktree,
      specPath,
      router,
      constitution: null,
      log: (type, msg, extra) => {
        logCalls.push([type, msg, extra]);
      },
    });

    const rework = logCalls.find(([type]) => type === 'rework')?.[2]?.rework;
    expect(rework).toMatchObject({ cause: 'factory-fault', failingChecks: ['lint'] });
    expect(rework?.failingTests).toBeUndefined();
    expect(rework?.failureOutput).toBeUndefined();
  });

  it('classifies the rework cause as direction-change when steering was applied', { timeout: 120_000 }, async () => {
    const { worktree, specPath } = await makeFailingWorktree();
    const { router } = makeRouter();
    const logCalls: Array<[string, string, ({ rework?: ReworkInfo } | undefined)?]> = [];
    const drainSteering = () => ({
      messages: [{ id: 'steer-1', issue: 77, text: 'change the spec', queuedAt: '2026-01-01T00:00:00.000Z' }],
      attachments: [],
    });

    await checkPhase({
      issue: 77,
      worktree,
      specPath,
      router,
      constitution: null,
      log: (type, msg, extra) => {
        logCalls.push([type, msg, extra]);
      },
      drainSteering,
    });

    const reworkCalls = logCalls.filter(([type]) => type === 'rework');
    expect(reworkCalls[0][2]?.rework?.cause).toBe('direction-change');
  });

  it(
    'emits a structured failover event from the rework site when the rework worker fails over',
    { timeout: 120_000 },
    async () => {
      const { worktree, specPath } = await makeFailingWorktree();
      const stub = new StubModelExecutor({
        scripts: { build_claude: [{ fail: 'usage_cap' }, { output: 'rework complete' }] },
        defaultOutput: 'rework complete',
      });
      const router = new ModelRouter(twoModels, routes, false, stub);
      const logCalls: Array<[string, string, ({ failoverReason?: string } | undefined)?]> = [];

      await checkPhase({
        issue: 78,
        worktree,
        specPath,
        router,
        constitution: null,
        log: (type, msg, extra) => {
          logCalls.push([type, msg, extra]);
        },
      });

      expect(logCalls).toContainEqual([
        'failover',
        expect.stringContaining('usage_cap'),
        { failoverReason: 'usage_cap' },
      ]);
    },
  );

  it(
    'classifies local auth router exhaustion as external and never produces a false stuck',
    { timeout: 120_000 },
    async () => {
      const { worktree, specPath } = await makeFailingWorktree();
      const stub = new StubModelExecutor({
        scripts: { build_claude: [{ fail: 'local_auth' }, { fail: 'local_auth' }, { fail: 'local_auth' }] },
        defaultOutput: 'rework complete',
      });
      const router = new ModelRouter(models, routes, false, stub);
      const logCalls: Array<[string, string, ({ failoverReason?: string; rework?: ReworkInfo } | undefined)?]> = [];

      const check = await checkPhase({
        issue: 642,
        worktree,
        specPath,
        router,
        constitution: null,
        log: (type, msg, extra) => {
          logCalls.push([type, msg, extra]);
        },
      });

      const failedCalls = logCalls.filter(([type]) => type === 'rework_model_failed');
      expect(failedCalls.length).toBeGreaterThan(0);
      expect(failedCalls[0][1]).toContain('local_auth');
      expect(failedCalls[0][2]).toEqual({ failoverReason: 'local_auth' });

      const reworkCalls = logCalls.filter(([type]) => type === 'rework');
      expect(reworkCalls.length).toBeGreaterThan(0);
      for (const call of reworkCalls) {
        expect(call[2]?.rework?.cause).toBe('external');
      }

      expect(logCalls.some(([type]) => type === 'stuck')).toBe(false);
      expect(check.stuck).toBeFalsy();
      expect(check.reworkRounds).toBe(3);
    },
  );

  it('classifies a non-external router exhaustion reason as factory-fault', { timeout: 120_000 }, async () => {
    const { worktree, specPath } = await makeFailingWorktree();
    const stub = new StubModelExecutor({
      scripts: { build_claude: [{ fail: 'error' }, { fail: 'error' }] },
      defaultOutput: 'rework complete',
    });
    const router = new ModelRouter(models, routes, false, stub);
    const logCalls: Array<[string, string, ({ failoverReason?: string; rework?: ReworkInfo } | undefined)?]> = [];

    await checkPhase({
      issue: 642,
      worktree,
      specPath,
      router,
      constitution: null,
      log: (type, msg, extra) => {
        logCalls.push([type, msg, extra]);
      },
      maxReworkRounds: 1,
    });

    const failedCalls = logCalls.filter(([type]) => type === 'rework_model_failed');
    expect(failedCalls.length).toBeGreaterThan(0);
    expect(failedCalls[0][2]).toEqual({ failoverReason: 'error' });

    const reworkCalls = logCalls.filter(([type]) => type === 'rework');
    expect(reworkCalls.length).toBeGreaterThan(0);
    expect(reworkCalls[0][2]?.rework?.cause).toBe('factory-fault');
  });

  it(
    'still emits failover events for real model switches recorded on a failed rework run',
    { timeout: 120_000 },
    async () => {
      const { worktree, specPath } = await makeFailingWorktree();
      const stub = new StubModelExecutor({
        scripts: { build_claude: [{ fail: 'usage_cap' }, { fail: 'usage_cap' }] },
        defaultOutput: 'rework complete',
      });
      const router = new ModelRouter(twoModels, routes, false, stub);
      const logCalls: Array<[string, string, ({ failoverReason?: string } | undefined)?]> = [];

      await checkPhase({
        issue: 642,
        worktree,
        specPath,
        router,
        constitution: null,
        log: (type, msg, extra) => {
          logCalls.push([type, msg, extra]);
        },
        maxReworkRounds: 1,
      });

      expect(logCalls).toContainEqual([
        'failover',
        expect.stringContaining('usage_cap'),
        { failoverReason: 'usage_cap' },
      ]);
      expect(logCalls.some(([type]) => type === 'rework_model_failed')).toBe(true);
    },
  );

  it(
    'omits the detail suffix from the rework failover log when the failed attempt carries no detail',
    { timeout: 120_000 },
    async () => {
      const { worktree, specPath } = await makeFailingWorktree();
      const fakeRouter = {
        run: async () => ({
          model: 'stub-model',
          output: 'reworked',
          exitCode: 0,
          attempts: [
            { model: 'first-model', reason: 'timeout' as const, ok: false },
            { model: 'stub-model', reason: null, ok: true },
          ],
        }),
      } as any;
      const logs: Array<{ type: string; msg: string }> = [];

      await checkPhase({
        issue: 99,
        worktree,
        specPath,
        router: fakeRouter,
        constitution: null,
        log: (type, msg) => {
          logs.push({ type, msg });
        },
      });

      expect(logs).toContainEqual({ type: 'failover', msg: 'first-model failed (timeout) — failed over' });
    },
  );
});

describe('checkPhase sandbox', () => {
  it('forwards the sandbox policy + onSandboxEvent from reworkWorker to router.run', { timeout: 120_000 }, async () => {
    const { worktree, specPath } = await makeFailingWorktree();
    const sandbox: SandboxPolicy = {
      runtime: 'firejail',
      worktree,
      writablePaths: [worktree],
      writableFilePrefixes: [],
      allowHosts: [],
      cpuMs: 300_000,
      memMb: 4096,
    };
    const captured: { options: any }[] = [];
    const fakeRouter = {
      run: async (_task: string, _prompt: string, options: any) => {
        captured.push({ options });
        return { model: 'fake-model', output: 'reworked', exitCode: 0, attempts: [] };
      },
    } as any;
    const logs: Array<{ type: string; msg: string }> = [];

    await checkPhase({
      issue: 96,
      worktree,
      specPath,
      router: fakeRouter,
      constitution: null,
      log: (type, msg) => {
        logs.push({ type, msg });
      },
      sandbox,
    });

    expect(captured.length).toBeGreaterThan(0);
    expect(captured[0].options.sandbox).toBe(sandbox);
    expect(typeof captured[0].options.onSandboxEvent).toBe('function');
    expect(captured[0].options.retryCause).toBe('checker');

    captured[0].options.onSandboxEvent('resource_limit', 'cpu time limit exceeded');
    expect(logs).toContainEqual({ type: 'resource_limit', msg: 'cpu time limit exceeded' });
  });
});

describe('checkPhase appPort', () => {
  let prevFactoryHeadless: string | undefined;

  beforeEach(() => {
    prevFactoryHeadless = process.env.FACTORY_HEADLESS;
    delete process.env.FACTORY_HEADLESS;
  });

  afterEach(() => {
    if (prevFactoryHeadless === undefined) delete process.env.FACTORY_HEADLESS;
    else process.env.FACTORY_HEADLESS = prevFactoryHeadless;
  });

  it('includes laneEnv in the rework router.run options when appPort is set', async () => {
    const { worktree, specPath } = await makeFailingWorktree();
    const captured: { options: any }[] = [];
    const fakeRouter = {
      run: async (_task: string, _prompt: string, options: any) => {
        captured.push({ options });
        return { model: 'fake-model', output: 'reworked', exitCode: 0, attempts: [] };
      },
    } as any;

    await checkPhase({
      issue: 99,
      worktree,
      specPath,
      router: fakeRouter,
      constitution: null,
      log: () => {},
      appPort: 3142,
    });

    expect(captured.length).toBeGreaterThan(0);
    expect(captured[0].options.env).toEqual({
      FACTORY_HEADLESS: '1',
      PLAYWRIGHT_HEADLESS: '1',
      PORT: '3142',
      FACTORY_APP_PORT: '3142',
      FACTORY_BASE_URL: 'http://127.0.0.1:3142',
    });
  });

  it('reaches the rework router.run options as FACTORY_BASE_URL while FACTORY_APP_PORT stays the raw port, when appBaseUrl is set', async () => {
    const { worktree, specPath } = await makeFailingWorktree();
    const captured: { options: any }[] = [];
    const fakeRouter = {
      run: async (_task: string, _prompt: string, options: any) => {
        captured.push({ options });
        return { model: 'fake-model', output: 'reworked', exitCode: 0, attempts: [] };
      },
    } as any;

    await checkPhase({
      issue: 101,
      worktree,
      specPath,
      router: fakeRouter,
      constitution: null,
      log: () => {},
      appPort: 3142,
      appBaseUrl: 'http://ship-it-101.factory.localhost',
    });

    expect(captured.length).toBeGreaterThan(0);
    expect(captured[0].options.env).toEqual({
      FACTORY_HEADLESS: '1',
      PLAYWRIGHT_HEADLESS: '1',
      PORT: '3142',
      FACTORY_APP_PORT: '3142',
      FACTORY_BASE_URL: 'http://ship-it-101.factory.localhost',
    });
  });

  it('carries headless-only env in the rework router.run options when appPort is unset', async () => {
    const { worktree, specPath } = await makeFailingWorktree();
    const captured: { options: any }[] = [];
    const fakeRouter = {
      run: async (_task: string, _prompt: string, options: any) => {
        captured.push({ options });
        return { model: 'fake-model', output: 'reworked', exitCode: 0, attempts: [] };
      },
    } as any;

    await checkPhase({
      issue: 100,
      worktree,
      specPath,
      router: fakeRouter,
      constitution: null,
      log: () => {},
    });

    expect(captured.length).toBeGreaterThan(0);
    expect(captured[0].options.env).toEqual({ FACTORY_HEADLESS: '1', PLAYWRIGHT_HEADLESS: '1' });
  });

  it('forwards onPgid to the rework router.run options', async () => {
    const { worktree, specPath } = await makeFailingWorktree();
    const captured: { options: any }[] = [];
    const fakeRouter = {
      run: async (_task: string, _prompt: string, options: any) => {
        captured.push({ options });
        return { model: 'fake-model', output: 'reworked', exitCode: 0, attempts: [] };
      },
    } as any;
    const onPgid = () => {};

    await checkPhase({
      issue: 103,
      worktree,
      specPath,
      router: fakeRouter,
      constitution: null,
      log: () => {},
      appPort: 3142,
      onPgid,
    });

    expect(captured.length).toBeGreaterThan(0);
    expect(captured[0].options.onPgid).toBe(onPgid);
  });

  it('forwards buildTimeoutSeconds to the rework router.run options as timeoutSeconds', async () => {
    const { worktree, specPath } = await makeFailingWorktree();
    const captured: { options: any }[] = [];
    const fakeRouter = {
      run: async (_task: string, _prompt: string, options: any) => {
        captured.push({ options });
        return { model: 'fake-model', output: 'reworked', exitCode: 0, attempts: [] };
      },
    } as any;

    await checkPhase({
      issue: 105,
      worktree,
      specPath,
      router: fakeRouter,
      constitution: null,
      log: () => {},
      buildTimeoutSeconds: 1234,
    });

    expect(captured.length).toBeGreaterThan(0);
    expect(captured[0].options.timeoutSeconds).toBe(1234);
  });

  it('threads the lane env into the checker ctx so checker commands see it', { timeout: 30_000 }, async () => {
    const worktree = await makeEnvAssertingWorktree(101);
    const { router, stub } = makeRouter();

    const check = await checkPhase({
      issue: 101,
      worktree,
      specPath: join(worktree, 'issue-101.md'),
      router,
      constitution: null,
      log: () => {},
      appPort: 3142,
      autoRework: false,
    });

    expect(check.passed).toBe(true);
    expect(stub.calls).toHaveLength(0);
  });

  it('fails the tests checker when appPort (and so ctx.env) is absent', { timeout: 30_000 }, async () => {
    const worktree = await makeEnvAssertingWorktree(102);
    const { router } = makeRouter();

    const check = await checkPhase({
      issue: 102,
      worktree,
      specPath: join(worktree, 'issue-102.md'),
      router,
      constitution: null,
      log: () => {},
      autoRework: false,
    });

    expect(check.passed).toBe(false);
    expect(check.summary.results.find((r) => r.checker === 'tests')?.result).toBe('FAIL');
  });

  it('emits an environment_warning when there is no leased port and the worktree runs Playwright', async () => {
    const worktree = await makeWorktreeWithFiles(103, { 'playwright.config.ts': 'export default {};\n' });
    const { router } = makeRouter();
    const logCalls: Array<[string, string]> = [];

    const check = await checkPhase({
      issue: 103,
      worktree,
      specPath: join(worktree, 'issue-103.md'),
      router,
      constitution: null,
      log: (type, msg) => logCalls.push([type, msg]),
      autoRework: false,
    });

    const warning = logCalls.find(([type]) => type === 'environment_warning');
    expect(warning).toBeDefined();
    expect(warning?.[1]).toContain('playwright.config.ts');
    expect(warning?.[1]).toContain('collide');
    expect(check).toBeDefined();
  });

  it('emits an environment_warning from a package.json e2e script when no playwright config is present', async () => {
    const worktree = await makeWorktreeWithFiles(104, {
      'package.json': JSON.stringify({ scripts: { e2e: 'playwright test' } }),
    });
    const { router } = makeRouter();
    const logCalls: Array<[string, string]> = [];

    await checkPhase({
      issue: 104,
      worktree,
      specPath: join(worktree, 'issue-104.md'),
      router,
      constitution: null,
      log: (type, msg) => logCalls.push([type, msg]),
      autoRework: false,
    });

    const warning = logCalls.find(([type]) => type === 'environment_warning');
    expect(warning).toBeDefined();
    expect(warning?.[1]).toContain("package.json script 'e2e'");
  });

  it('does not warn when appPort is set, even if the worktree runs Playwright', async () => {
    const worktree = await makeWorktreeWithFiles(105, { 'playwright.config.ts': 'export default {};\n' });
    const { router } = makeRouter();
    const logCalls: Array<[string, string]> = [];

    await checkPhase({
      issue: 105,
      worktree,
      specPath: join(worktree, 'issue-105.md'),
      router,
      constitution: null,
      log: (type, msg) => logCalls.push([type, msg]),
      appPort: 3142,
      autoRework: false,
    });

    expect(logCalls.find(([type]) => type === 'environment_warning')).toBeUndefined();
  });

  it('does not warn when the worktree shows no live-app signal', async () => {
    const { worktree, specPath } = await makeFailingWorktree();
    const { router } = makeRouter();
    const logCalls: Array<[string, string]> = [];

    await checkPhase({
      issue: 106,
      worktree,
      specPath,
      router,
      constitution: null,
      log: (type, msg) => logCalls.push([type, msg]),
      autoRework: false,
    });

    expect(logCalls.find(([type]) => type === 'environment_warning')).toBeUndefined();
  });

  it('does not throw when package.json has a malformed scripts field', async () => {
    const worktree = await makeWorktreeWithFiles(107, {
      'package.json': JSON.stringify({ scripts: { e2e: true } }),
    });
    const { router } = makeRouter();
    const logCalls: Array<[string, string]> = [];

    await expect(
      checkPhase({
        issue: 107,
        worktree,
        specPath: join(worktree, 'issue-107.md'),
        router,
        constitution: null,
        log: (type, msg) => logCalls.push([type, msg]),
        autoRework: false,
      }),
    ).resolves.toBeDefined();

    expect(logCalls.find(([type]) => type === 'environment_warning')).toBeUndefined();
  });

  it('does not throw when package.json parses to a non-object (e.g. null)', async () => {
    const worktree = await makeWorktreeWithFiles(108, { 'package.json': 'null' });
    const { router } = makeRouter();

    await expect(
      checkPhase({
        issue: 108,
        worktree,
        specPath: join(worktree, 'issue-108.md'),
        router,
        constitution: null,
        log: () => {},
        autoRework: false,
      }),
    ).resolves.toBeDefined();
  });
});

describe('checkPhase headed-mode warnings', () => {
  it('warns and records summary.warnings when playwright.config.ts forces headless: false', async () => {
    const worktree = await makeWorktreeWithFiles(109, {
      'playwright.config.ts': 'export default { use: { headless: false } };\n',
    });
    const { router } = makeRouter();
    const logCalls: Array<[string, string]> = [];

    const check = await checkPhase({
      issue: 109,
      worktree,
      specPath: join(worktree, 'issue-109.md'),
      router,
      constitution: null,
      log: (type, msg) => logCalls.push([type, msg]),
      appPort: 3142,
      autoRework: false,
    });

    const warning = logCalls.find(
      ([type, msg]) => type === 'environment_warning' && msg.includes('playwright.config.ts'),
    );
    expect(warning).toBeDefined();
    expect(warning?.[1]).toContain('headless: false');
    expect(check.summary.warnings).toEqual(['playwright.config.ts forces headless: false']);
  });

  it('warns when a package.json script passes --headed', async () => {
    const worktree = await makeWorktreeWithFiles(110, {
      'package.json': JSON.stringify({ scripts: { e2e: 'playwright test --headed' } }),
    });
    const { router } = makeRouter();
    const logCalls: Array<[string, string]> = [];

    const check = await checkPhase({
      issue: 110,
      worktree,
      specPath: join(worktree, 'issue-110.md'),
      router,
      constitution: null,
      log: (type, msg) => logCalls.push([type, msg]),
      appPort: 3142,
      autoRework: false,
    });

    const warning = logCalls.find(
      ([type, msg]) => type === 'environment_warning' && msg.includes('headed e2e config detected'),
    );
    expect(warning).toBeDefined();
    expect(warning?.[1]).toContain('--headed');
    expect(check.summary.warnings).toEqual(["package.json script 'e2e' passes --headed"]);
  });

  it("warns when a package.json script runs 'cypress open'", async () => {
    const worktree = await makeWorktreeWithFiles(111, {
      'package.json': JSON.stringify({ scripts: { cy: 'cypress open' } }),
    });
    const { router } = makeRouter();
    const logCalls: Array<[string, string]> = [];

    const check = await checkPhase({
      issue: 111,
      worktree,
      specPath: join(worktree, 'issue-111.md'),
      router,
      constitution: null,
      log: (type, msg) => logCalls.push([type, msg]),
      autoRework: false,
    });

    const warning = logCalls.find(([type, msg]) => type === 'environment_warning' && msg.includes("script 'cy'"));
    expect(warning).toBeDefined();
    expect(warning?.[1]).toContain('cypress open');
    expect(check.summary.warnings).toEqual(["package.json script 'cy' runs 'cypress open' (interactive UI runner)"]);
  });

  it('does not warn for a plain headless playwright config and script', async () => {
    const worktree = await makeWorktreeWithFiles(112, {
      'playwright.config.ts': 'export default {};\n',
      'package.json': JSON.stringify({ scripts: { e2e: 'playwright test' } }),
    });
    const { router } = makeRouter();
    const logCalls: Array<[string, string]> = [];

    const check = await checkPhase({
      issue: 112,
      worktree,
      specPath: join(worktree, 'issue-112.md'),
      router,
      constitution: null,
      log: (type, msg) => logCalls.push([type, msg]),
      appPort: 3142,
      autoRework: false,
    });

    expect(
      logCalls.find(([type, msg]) => type === 'environment_warning' && msg.includes('headed e2e config detected')),
    ).toBeUndefined();
    expect(check.summary.warnings).toBeUndefined();
  });

  it('drops the warning from the final summary once rework fixes the headed config', { timeout: 120_000 }, async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'check-phase-headed-rework-'));
    tempDirs.add(worktree);
    const marker = join(worktree, 'fixed.marker');

    await writeFixture(worktree, 'playwright.config.ts', 'export default { use: { headless: false } };\n');
    await writeFixture(
      worktree,
      'package.json',
      JSON.stringify({ scripts: { test: `node -e "process.exit(require('fs').existsSync('${marker}') ? 0 : 1)"` } }),
    );
    const specPath = join(worktree, 'issue-113.md');
    await writeFixture(worktree, 'issue-113.md', '# Spec: headed config fixed by rework\n');

    const fakeRouter = {
      run: async () => {
        await writeFile(join(worktree, 'playwright.config.ts'), 'export default { use: { headless: true } };\n');
        await writeFile(marker, '');
        return { model: 'fake-model', output: 'fixed', exitCode: 0, attempts: [] };
      },
    } as any;

    const check = await checkPhase({
      issue: 113,
      worktree,
      specPath,
      router: fakeRouter,
      constitution: null,
      log: () => {},
    });

    expect(check.passed).toBe(true);
    expect(check.reworkRounds).toBe(1);
    expect(check.summary.warnings).toBeUndefined();
  });
});

describe('checkPhase success paths', () => {
  it('passes without rework when all checkers pass on a clean worktree', { timeout: 120_000 }, async () => {
    const { worktree, specPath } = await makePassingWorktree();
    const { router, stub } = makeRouter();
    const logs: Array<{ type: string; msg: string }> = [];

    const check = await checkPhase({
      issue: 88,
      worktree,
      specPath,
      router,
      constitution: null,
      log: (type, msg) => {
        logs.push({ type, msg });
      },
    });

    expect(check.passed).toBe(true);
    expect(check.reworkRounds).toBe(0);
    expect(check.summary.failures).toBe(0);
    // Worker is never invoked when nothing fails.
    expect(stub.calls).toHaveLength(0);
    // worker_output and design_smells skip in this non-git temp worktree.
    expect(logs).toContainEqual({ type: 'check', msg: 'All checkers passed (2 skipped)' });
  });

  it(
    'forwards onActivity to the checker context, invoked around every checker (#1326)',
    { timeout: 120_000 },
    async () => {
      const { worktree, specPath } = await makePassingWorktree();
      const { router } = makeRouter();
      let activityCalls = 0;

      const check = await checkPhase({
        issue: 88,
        worktree,
        specPath,
        router,
        constitution: null,
        log: () => {},
        onActivity: () => {
          activityCalls++;
        },
      });

      expect(check.passed).toBe(true);
      expect(activityCalls).toBe(check.summary.total * 2);
    },
  );

  it('passes with a skipped tests checker when the worktree has no test command', { timeout: 120_000 }, async () => {
    const { worktree, specPath } = await makeSpecOnlyWorktree();
    const { router, stub } = makeRouter();
    const logs: Array<{ type: string; msg: string }> = [];

    const check = await checkPhase({
      issue: 94,
      worktree,
      specPath,
      router,
      constitution: null,
      log: (type, msg) => {
        logs.push({ type, msg });
      },
    });

    expect(check.passed).toBe(true);
    expect(stub.calls).toHaveLength(0);
    expect(logs.some((l) => l.type === 'check' && l.msg.startsWith('SKIPPED: tests'))).toBe(true);
    // worker_output and design_smells also skip in this non-git temp worktree.
    expect(logs).toContainEqual({ type: 'check', msg: 'All checkers passed (3 skipped)' });
  });

  it(
    'fails the tests checker when requireTests is true and the worktree has no test command',
    { timeout: 120_000 },
    async () => {
      const { worktree, specPath } = await makeSpecOnlyWorktree();
      const { router } = makeRouter();
      const constitution: Constitution = {
        product: 'strict-app',
        version: 1,
        checkers: [],
        requireTests: true,
        body: 'Strict standards body.',
        path: worktree,
        source: 'bundled',
      };

      const logs: Array<{ type: string; msg: string }> = [];
      const check = await checkPhase({
        issue: 95,
        worktree,
        specPath,
        router,
        constitution,
        log: (type, msg) => {
          logs.push({ type, msg });
        },
        autoRework: false,
      });

      expect(check.passed).toBe(false);
      const testsFailure = check.summary.results.find((r) => r.checker === 'tests');
      expect(testsFailure?.result).toBe('FAIL');
      expect(testsFailure?.details).toContain('no verification command was run');
      // Each failing checker is named individually — the parked outcome carries only an
      // aggregate count, so this is the operator's only view of WHY a run parked (#675).
      expect(logs.some((l) => l.type === 'check' && l.msg.startsWith('FAILED: tests — '))).toBe(true);
    },
  );

  it('exits the rework loop early once a round repairs the failing check', { timeout: 120_000 }, async () => {
    const { worktree, specPath } = await makeFailingWorktree();
    // The scripted worker "fixes" the repo the first time it is invoked by
    // rewriting the failing test script to pass, so the next check round is clean.
    const stub = new StubModelExecutor({
      scripts: {
        build_claude: [
          {
            output: 'fixed the failing test',
            effect: async (ctx) => {
              await writeFile(join(ctx.worktree, 'package.json'), JSON.stringify({ scripts: { test: 'exit 0' } }));
            },
          },
        ],
      },
    });
    const router = new ModelRouter(models, routes, false, stub);
    const logs: Array<{ type: string; msg: string }> = [];

    const check = await checkPhase({
      issue: 89,
      worktree,
      specPath,
      router,
      constitution: null,
      log: (type, msg) => {
        logs.push({ type, msg });
      },
    });

    expect(check.passed).toBe(true);
    expect(check.reworkRounds).toBe(1);
    // Only one rework round was needed, so the worker was invoked exactly once.
    expect(stub.calls).toHaveLength(1);
    expect(logs).toContainEqual({ type: 'check', msg: 'Rework round 1: 0 failures remaining' });
    // worker_output and design_smells skip in this non-git temp worktree.
    expect(logs).toContainEqual({ type: 'check', msg: 'All checkers passed (2 skipped)' });
  });
});

describe('checkPhase steering', () => {
  it('invokes drainSteering once per rework round', { timeout: 120_000 }, async () => {
    const { worktree, specPath } = await makeFailingWorktree();
    const { router } = makeRouter();
    let calls = 0;
    const drainSteering = () => {
      calls++;
      return { messages: [], attachments: [] };
    };

    await checkPhase({
      issue: 100,
      worktree,
      specPath,
      router,
      constitution: null,
      log: () => {},
      drainSteering,
    });

    expect(calls).toBe(2);
  });

  it('applies drained steering to the rework prompt and logs steering_applied', { timeout: 120_000 }, async () => {
    const { worktree, specPath } = await makeFailingWorktree();
    const captured: string[] = [];
    const fakeRouter = {
      run: async (_task: string, prompt: string, _options: any) => {
        captured.push(prompt);
        return { model: 'fake-model', output: 'reworked', exitCode: 0, attempts: [] };
      },
    } as any;
    const logs: Array<{ type: string; msg: string }> = [];
    const drainSteering = () => ({
      messages: [
        { id: 'steer-1', issue: 100, text: 'focus on the lock file bug', queuedAt: '2026-01-01T00:00:00.000Z' },
      ],
      attachments: [],
    });

    await checkPhase({
      issue: 100,
      worktree,
      specPath,
      router: fakeRouter,
      constitution: null,
      log: (type, msg) => logs.push({ type, msg }),
      drainSteering,
      autoRework: true,
    });

    expect(captured[0]).toContain('## Operator guidance (steering)');
    expect(captured[0]).toContain('focus on the lock file bug');
    expect(logs.some((l) => l.type === 'steering_applied' && l.msg.includes('steer-1'))).toBe(true);
  });

  it(
    'leaves the rework prompt unchanged and logs nothing extra when no drainSteering is passed',
    { timeout: 120_000 },
    async () => {
      const { worktree, specPath } = await makeFailingWorktree();
      const captured: string[] = [];
      const fakeRouter = {
        run: async (_task: string, prompt: string, _options: any) => {
          captured.push(prompt);
          return { model: 'fake-model', output: 'reworked', exitCode: 0, attempts: [] };
        },
      } as any;
      const logs: Array<{ type: string; msg: string }> = [];

      await checkPhase({
        issue: 101,
        worktree,
        specPath,
        router: fakeRouter,
        constitution: null,
        log: (type, msg) => logs.push({ type, msg }),
      });

      expect(captured[0]).not.toContain('## Operator guidance (steering)');
      expect(logs.some((l) => l.type === 'steering_applied')).toBe(false);
    },
  );

  it(
    'logs no steering_applied event and leaves the prompt unchanged when drainSteering returns empty',
    { timeout: 120_000 },
    async () => {
      const { worktree, specPath } = await makeFailingWorktree();
      const captured: string[] = [];
      const fakeRouter = {
        run: async (_task: string, prompt: string, _options: any) => {
          captured.push(prompt);
          return { model: 'fake-model', output: 'reworked', exitCode: 0, attempts: [] };
        },
      } as any;
      const logs: Array<{ type: string; msg: string }> = [];

      await checkPhase({
        issue: 102,
        worktree,
        specPath,
        router: fakeRouter,
        constitution: null,
        log: (type, msg) => logs.push({ type, msg }),
        drainSteering: () => ({ messages: [], attachments: [] }),
      });

      expect(captured[0]).not.toContain('## Operator guidance (steering)');
      expect(logs.some((l) => l.type === 'steering_applied')).toBe(false);
    },
  );
});

describe('checkPhase lifecycle events', () => {
  it(
    'emits started then done on the success path, validated against the shared schema',
    { timeout: 120_000 },
    async () => {
      const { worktree, specPath } = await makePassingWorktree();
      const { router } = makeRouter();
      const bus = createLifecycleBus();
      const received: any[] = [];
      bus.on((e) => received.push(e));

      await checkPhase({
        issue: 591,
        worktree,
        specPath,
        router,
        constitution: null,
        log: () => {},
        bus,
        laneId: 'lane-1',
      });

      expect(received.map((e) => ({ phase: e.phase, status: e.status }))).toEqual([
        { phase: 'check', status: 'started' },
        { phase: 'check', status: 'done' },
      ]);
      expect(received.every((e) => e.laneId === 'lane-1')).toBe(true);
      expect(received.every((e) => e.issueId === '591')).toBe(true);
      expect(received.every((e) => e.worktreePath === worktree)).toBe(true);
      for (const event of received) {
        expect(() => LaneLifecycleEventSchema.parse(event)).not.toThrow();
      }
    },
  );

  it('emits started then failed on the failure path, with a non-empty detail', { timeout: 120_000 }, async () => {
    const { worktree, specPath } = await makeFailingWorktree();
    const { router } = makeRouter();
    const bus = createLifecycleBus();
    const received: any[] = [];
    bus.on((e) => received.push(e));

    await checkPhase({
      issue: 592,
      worktree,
      specPath,
      router,
      constitution: null,
      log: () => {},
      autoRework: false,
      bus,
      laneId: 'lane-1',
    });

    expect(received.map((e) => e.status)).toEqual(['started', 'failed']);
    expect(received[1].detail.length).toBeGreaterThan(0);
  });
});

async function makePassingWorktree(): Promise<{ worktree: string; specPath: string }> {
  const worktree = await mkdtemp(join(tmpdir(), 'check-phase-pass-'));
  tempDirs.add(worktree);

  await writeFixture(
    worktree,
    'package.json',
    JSON.stringify({
      scripts: { test: 'exit 0' },
    }),
  );

  const specPath = join(worktree, 'issue-88.md');
  await writeFixture(worktree, 'issue-88.md', '# Spec: passing checks\n');

  return { worktree, specPath };
}

async function makeSpecOnlyWorktree(): Promise<{ worktree: string; specPath: string }> {
  const worktree = await mkdtemp(join(tmpdir(), 'check-phase-spec-only-'));
  tempDirs.add(worktree);

  const specPath = join(worktree, 'issue-94.md');
  await writeFixture(worktree, 'issue-94.md', '# Spec: no package.json at all\n');

  return { worktree, specPath };
}

async function makeFailingWorktree(): Promise<{ worktree: string; specPath: string }> {
  const worktree = await mkdtemp(join(tmpdir(), 'check-phase-test-'));
  tempDirs.add(worktree);

  await writeFixture(
    worktree,
    'package.json',
    JSON.stringify({
      scripts: { test: 'exit 1' },
    }),
  );

  const specPath = join(worktree, 'issue-77.md');
  await writeFixture(worktree, 'issue-77.md', '# Spec: failing checks\n');

  return { worktree, specPath };
}

async function makeCleanGitWorktree(): Promise<{ worktree: string; specPath: string }> {
  const worktree = await mkdtemp(join(tmpdir(), 'check-phase-clean-git-'));
  tempDirs.add(worktree);
  const specPath = join(worktree, 'issue-817.md');
  await writeFixture(worktree, 'package.json', JSON.stringify({ scripts: { test: 'exit 0' } }));
  await writeFixture(worktree, 'issue-817.md', '# Spec: empty worker diff\n');
  await execFile('git', ['init', '--initial-branch=main'], { cwd: worktree });
  await execFile('git', ['config', 'user.email', 'tests@example.com'], { cwd: worktree });
  await execFile('git', ['config', 'user.name', 'Tests'], { cwd: worktree });
  await execFile('git', ['add', '.'], { cwd: worktree });
  await execFile('git', ['commit', '-m', 'initial'], { cwd: worktree });
  await execFile('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: worktree });
  return { worktree, specPath };
}

/** makeCleanGitWorktree without the origin/main ref — a remote-less checkout whose only
 *  usable diff base is the run-start SHA buildPhase captured (#1211). */
async function makeRemoteLessGitWorktree(): Promise<{ worktree: string; specPath: string; baseSha: string }> {
  const worktree = await mkdtemp(join(tmpdir(), 'check-phase-remoteless-git-'));
  tempDirs.add(worktree);
  const specPath = join(worktree, 'issue-1211.md');
  await writeFixture(worktree, 'package.json', JSON.stringify({ scripts: { test: 'exit 0' } }));
  await writeFixture(worktree, 'issue-1211.md', '# Spec: empty worker diff, no remote\n');
  await execFile('git', ['init', '--initial-branch=main'], { cwd: worktree });
  await execFile('git', ['config', 'user.email', 'tests@example.com'], { cwd: worktree });
  await execFile('git', ['config', 'user.name', 'Tests'], { cwd: worktree });
  await execFile('git', ['add', '.'], { cwd: worktree });
  await execFile('git', ['commit', '-m', 'initial'], { cwd: worktree });
  const { stdout } = await execFile('git', ['rev-parse', 'HEAD'], { cwd: worktree });
  return { worktree, specPath, baseSha: stdout.trim() };
}

async function makeTestFailureEvidenceWorktree(): Promise<{ worktree: string; specPath: string }> {
  const worktree = await mkdtemp(join(tmpdir(), 'check-phase-test-evidence-'));
  tempDirs.add(worktree);
  const diagnostic = 'diagnostic output '.repeat(100);

  await writeFixture(
    worktree,
    'package.json',
    JSON.stringify({
      scripts: {
        test: `node -e "console.error('FAIL  src/phases/build.test.ts > buildPhase > uses the Codex route\\nnot ok 2 - reports the fallback warning\\nFAIL  restores the inherited environment\\nFAIL  fourth identifier is excluded\\n${diagnostic}'); process.exit(1)"`,
      },
    }),
  );

  const specPath = join(worktree, 'issue-491.md');
  await writeFixture(worktree, 'issue-491.md', '# Spec: capture test failure evidence\n');
  return { worktree, specPath };
}

async function makeLintFailingWorktree(): Promise<{ worktree: string; specPath: string }> {
  const worktree = await mkdtemp(join(tmpdir(), 'check-phase-lint-failure-'));
  tempDirs.add(worktree);

  await writeFixture(worktree, 'package.json', JSON.stringify({ scripts: { test: 'exit 0', lint: 'exit 1' } }));

  const specPath = join(worktree, 'issue-492.md');
  await writeFixture(worktree, 'issue-492.md', '# Spec: non-test failure evidence\n');
  return { worktree, specPath };
}

/** Worktree whose package.json `test` script exits 0 only when PORT/FACTORY_APP_PORT/FACTORY_BASE_URL were forwarded into its process env. */
function lensSummary(details: string, result: 'FAIL' | 'PASS' = 'FAIL'): CheckSummary {
  return {
    failures: result === 'FAIL' ? 1 : 0,
    passes: result === 'PASS' ? 1 : 0,
    skips: 0,
    total: 1,
    results: [{ checker: LENS_REVIEW_CHECKER, result, details }],
  };
}

describe('lensShowstopperRefs', () => {
  it('parses file:line refs from showstopper lines', () => {
    expect(
      lensShowstopperRefs(
        'src/a.ts:12 — x. Failure scenario: y (lenses: security)\nsrc/b.ts:3 — z. Failure scenario: w (lenses: techlead, product)',
      ),
    ).toEqual(['src/a.ts:12', 'src/b.ts:3']);
  });

  it('sorts and de-duplicates', () => {
    expect(lensShowstopperRefs('b.ts:1 — x\na.ts:2 — y\na.ts:2 — z')).toEqual(['a.ts:2', 'b.ts:1']);
  });

  it('accepts bullets, leading whitespace and dash variants', () => {
    expect(lensShowstopperRefs('- a.ts:1 — x\n  * b.ts:2 - y\n• c.ts:3 – z')).toEqual(['a.ts:1', 'b.ts:2', 'c.ts:3']);
  });

  it('skips headers and unparsable text', () => {
    expect(lensShowstopperRefs('2 showstoppers:\na.ts:1 — x')).toEqual(['a.ts:1']);
    expect(lensShowstopperRefs('')).toEqual([]);
    expect(lensShowstopperRefs('lens security returned malformed JSON')).toEqual([]);
  });

  it('keeps a Windows drive path intact', () => {
    expect(lensShowstopperRefs('C:\\x\\a.ts:12 — s')).toEqual(['C:\\x\\a.ts:12']);
  });
});

describe('stuckSignature for lens_review', () => {
  const sig = (s: CheckSummary) => stuckSignature(s, new Set());

  it('is equal for the same refs regardless of wording or order', () => {
    const a = lensSummary(
      'a.ts:1 — one. Failure scenario: s (lenses: security)\nb.ts:2 — two. Failure scenario: t (lenses: product)',
    );
    const b = lensSummary(
      'b.ts:2 — other words. Failure scenario: q (lenses: techlead)\na.ts:1 — new text. Failure scenario: r (lenses: a, b)',
    );
    expect(sig(a)).toBe(sig(b));
  });

  it('differs when refs differ', () => {
    expect(sig(lensSummary('a.ts:1 — x'))).not.toBe(sig(lensSummary('a.ts:2 — x')));
  });

  it('falls back to normalized detail when no refs parse', () => {
    expect(sig(lensSummary('lens security returned malformed JSON'))).toBe(
      'lens_review:lens security returned malformed json',
    );
    expect(sig(lensSummary('reason one'))).not.toBe(sig(lensSummary('reason two')));
  });

  it('leaves other checkers on normalized detail', () => {
    const t = (d: string): CheckSummary => ({
      failures: 1,
      passes: 0,
      skips: 0,
      total: 1,
      results: [{ checker: 'tests', result: 'FAIL', details: d }],
    });
    expect(sig(t('3 failed'))).toBe(sig(t('4 failed')));
    expect(sig(t('3 failed'))).toBe('tests:# failed');
  });
});

describe('remainingShowstoppers', () => {
  it('returns trimmed showstopper lines of a lens_review FAIL', () => {
    expect(remainingShowstoppers(lensSummary('2 showstoppers:\n  - a.ts:1 — x\nb.ts:2 — y'))).toEqual([
      '- a.ts:1 — x',
      'b.ts:2 — y',
    ]);
  });

  it('is empty when lens_review passes or is absent', () => {
    expect(remainingShowstoppers(lensSummary('a.ts:1 — x', 'PASS'))).toEqual([]);
    expect(remainingShowstoppers({ failures: 0, passes: 0, skips: 0, total: 0, results: [] })).toEqual([]);
  });
});

describe('checkPhase with lens_review signatures', () => {
  const run = async (issue: number, detailsFor: (n: number) => string) => {
    const worktree = await makeWorktreeWithFiles(issue, {});
    const { router } = makeRouter();
    const events: Array<[string, string]> = [];
    let n = 0;
    const check = await checkPhase({
      issue,
      worktree,
      specPath: join(worktree, `issue-${issue}.md`),
      router,
      constitution: null,
      log: (type, msg) => {
        events.push([type, msg]);
      },
      runCheckers: async () => lensSummary(detailsFor(++n)),
    });
    return { check, events };
  };

  it('treats reworded findings at the same refs as stuck', { timeout: 120_000 }, async () => {
    const { check, events } = await run(
      2238,
      (n) => `src/a.ts:12 — wording v${n}. Failure scenario: s${n} (lenses: security)`,
    );
    expect(check.stuck).toBe(true);
    expect(check.reworkRounds).toBe(2);
    expect(check.passed).toBe(false);
    expect(events.filter(([t]) => t === 'stuck')).toHaveLength(1);
    expect(check.summary.results[0]?.details).toContain('src/a.ts:12');
    expect(events.find(([t]) => t === 'fail')?.[1]).toContain('src/a.ts:12');
  });

  it('caps at MAX_REWORK_ROUNDS when refs keep changing', { timeout: 120_000 }, async () => {
    const { check, events } = await run(2239, (n) => `src/a.ts:${n} — w. Failure scenario: s (lenses: security)`);
    expect(check.reworkRounds).toBe(3);
    expect(check.stuck).toBe(false);
    expect(check.passed).toBe(false);
    const failMsg = events.find(([t]) => t === 'fail')?.[1] ?? '';
    expect(failMsg).toContain('remaining showstoppers');
    expect(failMsg).toContain('src/a.ts:4');
  });

  it('never exceeds the cap with constant wording', { timeout: 120_000 }, async () => {
    const { check } = await run(2240, () => 'src/a.ts:12 — same. Failure scenario: s (lenses: security)');
    expect(check.reworkRounds).toBeLessThanOrEqual(3);
  });
});

async function makeEnvAssertingWorktree(issue: number): Promise<string> {
  const worktree = await mkdtemp(join(tmpdir(), `check-phase-env-${issue}-`));
  tempDirs.add(worktree);

  const check =
    "process.env.PORT === '3142' && process.env.FACTORY_APP_PORT === '3142' && process.env.FACTORY_BASE_URL === 'http://127.0.0.1:3142'";
  await writeFixture(
    worktree,
    'package.json',
    JSON.stringify({ scripts: { test: `node -e "process.exit(${check} ? 0 : 1)"` } }),
  );
  await writeFixture(worktree, `issue-${issue}.md`, `# Spec: env-asserting checks\n`);

  return worktree;
}

async function makeWorktreeWithFiles(issue: number, files: Record<string, string>): Promise<string> {
  const worktree = await mkdtemp(join(tmpdir(), `check-phase-files-${issue}-`));
  tempDirs.add(worktree);

  for (const [path, contents] of Object.entries(files)) {
    await writeFixture(worktree, path, contents);
  }
  await writeFixture(worktree, `issue-${issue}.md`, `# Spec: live-app signal detection\n`);

  return worktree;
}

async function writeFixture(root: string, path: string, contents: string): Promise<void> {
  const fullPath = join(root, path);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, contents);
}

function makeRouter(): { router: ModelRouter; stub: StubModelExecutor } {
  const stub = new StubModelExecutor({ defaultOutput: 'rework complete' });
  return { router: new ModelRouter(models, routes, false, stub), stub };
}

describe('checkPhase tests timeout (#2299)', () => {
  it('threads testsTimeoutSeconds into the checker context', async () => {
    const worktree = await makeWorktreeWithFiles(2299, {});
    const { router } = makeRouter();
    let seen: number | undefined;
    await checkPhase({
      issue: 2299,
      worktree,
      specPath: join(worktree, 'issue-2299.md'),
      router,
      constitution: null,
      log: () => {},
      testsTimeoutSeconds: 1200,
      runCheckers: async (ctx) => {
        seen = ctx.testsTimeoutSeconds;
        return {
          failures: 0,
          passes: 1,
          skips: 0,
          total: 1,
          results: [{ checker: 'tests', result: 'PASS', details: 'ok' }],
        };
      },
    });
    expect(seen).toBe(1200);
  });
});

describe('flaky re-run verdict (#2301, #2302)', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });
  const okResult = {
    command: ['npm', 'test'],
    stdout: '',
    stderr: '',
    exitCode: 0,
    killed: false,
    timedOut: false,
    ok: true,
  };
  const summaryOf = (...checkers: string[]): CheckSummary => ({
    results: checkers.map((checker) => ({ checker, result: 'FAIL' as const, details: ' × suite > adds' })),
    failures: checkers.length,
    passes: 0,
    skips: 0,
    total: checkers.length,
  });

  const run = async (
    checkers: string[],
    verdict: 'fails-on-base' | 'clean-on-base',
    runCommand: ReturnType<typeof vi.fn>,
    extra: { maxReworkRounds?: number } = {},
  ) => {
    const worktree = await mkdtemp(join(tmpdir(), 'check-flaky-'));
    dirs.push(worktree);
    await writeFile(join(worktree, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));
    const { router } = makeRouter();
    const logs: string[] = [];
    const result = await checkPhase({
      issue: 5,
      worktree,
      specPath: join(worktree, 'spec.md'),
      router,
      constitution: null,
      diffBase: 'abc1234567',
      maxReworkRounds: 1,
      ...extra,
      log: (_t, msg) => {
        logs.push(msg);
      },
      runCheckers: async () => summaryOf(...checkers),
      runBaseline: async (o) =>
        ({
          baseSha: o.baseSha,
          checkers: o.failing
            .filter((r) => r.result === 'FAIL')
            .map((r) => ({ checker: r.checker, verdict, baseResult: 'FAIL' })),
        }) as BaselineReport,
      runCommand: runCommand as never,
    });
    return { result, logs };
  };

  it('continues when the only base-red checker is flaky', async () => {
    const fake = vi.fn(async (_argv: readonly string[]) => okResult);
    const { result, logs } = await run(['tests'], 'fails-on-base', fake);
    expect(fake).toHaveBeenCalledTimes(1);
    expect(fake.mock.calls[0]?.[0]).toEqual(['npm', 'test', '--', '-t', 'adds', '--no-file-parallelism']);
    expect((fake.mock.calls[0] as unknown[])[1]).toMatchObject({ timeoutMs: 600_000 });
    expect(result.flakeRerun?.verdict).toBe('passed');
    expect(result.environment).toBeUndefined();
    expect(result.passed).toBe(true);
    expect(result.summary.failures).toBe(0);
    expect(result.summary.results.find((r) => r.checker === 'tests')).toMatchObject({
      result: 'PASS',
      details: 're-run passed; flaky: adds',
    });
    expect(result.reworkRounds).toBe(0);
    expect(logs).toContain('flaky re-run: passed (targeted, 1 tests)');
  });

  it('keeps the environment release without tests when lint is also base-red', async () => {
    const fake = vi.fn(async (_argv: readonly string[]) => okResult);
    const { result } = await run(['tests', 'lint'], 'fails-on-base', fake);
    expect(fake).toHaveBeenCalledTimes(1);
    expect(result.passed).toBe(false);
    expect(result.environment?.failingChecks).toEqual(['lint']);
    expect(result.failureSignature).not.toContain('tests:');
    expect(result.flakeRerun?.verdict).toBe('passed');
  });

  it('reports reproduced', async () => {
    const fake = vi.fn(async () => ({ ...okResult, exitCode: 1, ok: false }));
    const { result } = await run(['tests'], 'fails-on-base', fake);
    expect(result.flakeRerun?.verdict).toBe('reproduced');
    expect(result.environment?.failingChecks).toEqual(['tests']);
    expect(result.summary.results[0]?.result).toBe('FAIL');
  });

  it('reports not-run when the command throws', async () => {
    const fake = vi.fn(async () => {
      throw new Error('spawn ENOENT');
    });
    const { result, logs } = await run(['tests'], 'fails-on-base', fake);
    expect(result.flakeRerun).toMatchObject({ verdict: 'not-run', reason: expect.stringContaining('spawn ENOENT') });
    expect(result.environment?.failingChecks).toEqual(['tests']);
    expect(result.summary.results[0]?.result).toBe('FAIL');
    expect(logs.some((l) => l.startsWith('flaky re-run: not-run') && l.includes('spawn ENOENT'))).toBe(true);
  });

  it('skips the re-run when tests is not failing', async () => {
    const fake = vi.fn(async () => okResult);
    const { result } = await run(['lint'], 'fails-on-base', fake);
    expect(fake).not.toHaveBeenCalled();
    expect(result.flakeRerun).toBeUndefined();
    expect(result.environment).toBeDefined();
  });

  it('skips the re-run when the cause is not environment', async () => {
    const fake = vi.fn(async () => okResult);
    const { result } = await run(['tests'], 'clean-on-base', fake, { maxReworkRounds: 0 });
    expect(fake).not.toHaveBeenCalled();
    expect(result.flakeRerun).toBeUndefined();
  });
});

describe('markTestsFlaky (#2302)', () => {
  const base: CheckSummary = {
    results: [
      { checker: 'tests', result: 'FAIL', details: 'x' },
      { checker: 'lint', result: 'FAIL', details: 'y' },
      { checker: 'types', result: 'PASS', details: 'z' },
    ],
    failures: 2,
    passes: 1,
    skips: 3,
    total: 6,
  };

  it('joins targeted names, recomputes counts and preserves other fields', () => {
    const out = markTestsFlaky(base, { verdict: 'passed', mode: 'targeted', tests: ['a', 'b'] });
    expect(out.results[0]).toEqual({ checker: 'tests', result: 'PASS', details: 're-run passed; flaky: a, b' });
    expect(out.results[1]).toBe(base.results[1]);
    expect(out.failures).toBe(1);
    expect(out.passes).toBe(2);
    expect(out.skips).toBe(3);
    expect(out.total).toBe(6);
  });

  it('falls back to full suite and leaves a non-FAIL tests result alone', () => {
    const out = markTestsFlaky(base, { verdict: 'passed', mode: 'full', tests: [] });
    expect(out.results[0]?.details).toBe('re-run passed; flaky: full suite');
    const passing: CheckSummary = { ...base, results: [{ checker: 'tests', result: 'PASS', details: 'ok' }] };
    expect(markTestsFlaky(passing, { verdict: 'passed', mode: 'full', tests: [] }).results[0]?.details).toBe('ok');
  });
});
