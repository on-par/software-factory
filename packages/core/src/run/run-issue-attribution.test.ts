import { join } from 'node:path';

import { createTempDirs } from '@on-par/factory-core/testing';
import type { Octokit } from '@octokit/rest';
import { afterAll, describe, expect, it, vi } from 'vitest';

import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import type { buildPhase as realBuildPhase } from '../phases/build.js';
import type { checkPhase as realCheckPhase } from '../phases/check.js';
import type { PlanResult, planPhase as realPlanPhase } from '../phases/plan.js';
import type { shipPhase as realShipPhase } from '../phases/ship.js';
import { ProviderBreaker } from '../router/breaker.js';
import { ModelRouter } from '../router/index.js';
import type { CheckSummary } from '../types/index.js';
import type { WorkRequest } from '../work/index.js';
import type { RunPolicy } from './policy.js';
import type { Workspace } from './ports.js';
import { runIssue, type RunPorts, type RunRequest } from './run-issue.js';

const WORK: WorkRequest = {
  id: 'github-issue:o/r#1',
  kind: 'github-issue',
  title: 'Fix the thing',
  brief: 'do the thing',
  acceptanceCriteria: [],
};

const ROUTES: RoutesConfig = {
  version: 1,
  routes: {
    build_claude: { tier: 'worker', description: 'stub', requires: 'claude' },
    build_codex: { tier: 'worker', description: 'stub', requires: 'codex' },
    build_command: { tier: 'worker', description: 'stub', requires: 'command' },
  },
};

const model = (provider: 'anthropic' | 'openai', harness: string) => ({
  provider,
  tier: 'worker' as const,
  costPerMtokInput: 0,
  costPerMtokOutput: 0,
  contextWindow: 1000,
  capabilities: [],
  envKey: null,
  harness,
});

const MODELS: ModelsConfig = {
  version: 1,
  models: {
    'claude-opus-5-5': model('anthropic', 'claude-cli'),
    'gpt-6-luna-high': model('openai', 'codex-cli'),
  },
  tiers: { worker: ['claude-opus-5-5', 'gpt-6-luna-high'] },
  failover: { triggers: [], maxRetries: 0, cooldownMs: 0, escalateAfterTierExhausted: false },
  routingRules: {},
  efforts: { 'claude-opus-5-5': 'high', 'gpt-6-luna-high': 'xhigh' },
};

const dirs = createTempDirs();
const breakerDir = dirs.makeSync('run-issue-attribution-');
afterAll(() => dirs.cleanup());

const request: RunRequest = {
  issue: 1,
  repo: 'o/r',
  branch: 'issue-1-fix-the-thing',
  specPath: '/tmp/wt/spec.md',
  work: WORK,
  startedAt: '2026-01-01T00:00:00.000Z',
  options: { interactive: false, autoRework: true, approvePlan: false, sandboxDisabled: false },
  timeouts: { plan: 60, build: 60, check: 60, approval: 60, tests: 60 },
  modelPins: { sources: {} },
  codexDisabled: false,
  skipCI: false,
  failover: { enabled: false, cooldownMs: 60_000, fallbackModel: 'claude-sonnet-5' },
  efficiency: { maxReworkRounds: 1, fastPath: false },
  processGroupGraceMs: 50,
};

const policy: RunPolicy = {
  models: MODELS,
  routes: ROUTES,
  sandbox: {
    enabled: false,
    runtime: 'auto',
    network: { allow: [] },
    resources: { cpuMs: 0, memMb: 0 },
    docker: { rolloutPercent: 0 },
  },
  budget: {},
  effective: {} as RunPolicy['effective'],
};

const SUMMARY: CheckSummary = { failures: 1, passes: 0, skips: 0, total: 1, results: [] };
const PLAN_OK: PlanResult = { ok: true, route: 'codex', specPath: '/tmp/wt/spec.md', model: 'm', designArtifact: null };

/** The model each router task resolves to; the router spy answers with it. */
type Resolve = Record<string, string>;

function setup(resolve: Resolve) {
  const router = new ModelRouter(MODELS, ROUTES);
  vi.spyOn(router, 'run').mockImplementation(async (task) => ({
    model: resolve[task] ?? 'claude-opus-5-5',
    output: '',
    exitCode: 0,
    attempts: [],
  }));
  const log = vi.fn();
  const planPhase = vi.fn<typeof realPlanPhase>();
  const buildPhase = vi.fn<typeof realBuildPhase>();
  const checkPhase = vi.fn<typeof realCheckPhase>();
  const ports: RunPorts = {
    router,
    octokit: {} as Octokit,
    workspace: { path: '/tmp/wt', dispose: async () => {} } as Workspace,
    events: () => log,
    breaker: new ProviderBreaker(join(breakerDir, 'breaker.json')),
    resolveConstitution: () => null,
    planPhase,
    buildPhase,
    checkPhase,
    shipPhase: vi.fn<typeof realShipPhase>(),
  };
  return { ports, log, planPhase, buildPhase, checkPhase };
}

const callsOf = (log: ReturnType<typeof vi.fn>, type: string) => log.mock.calls.filter((c) => c[0] === type);

describe('runIssue — plan/build attribution on terminal events (#3321)', () => {
  it('terminal events carry plan and build model and provider (ship-it #305 failover case)', async () => {
    const { ports, log, planPhase, buildPhase, checkPhase } = setup({
      plan: 'claude-opus-5-5',
      build_codex: 'gpt-6-luna-high',
    });
    planPhase.mockImplementation(async (opts) => {
      await opts.router.run('plan', 'p', {});
      return PLAN_OK;
    });
    buildPhase.mockImplementation(async (opts) => {
      await opts.router.run('build_codex', 'b', {});
      return { ok: true, model: 'gpt-6-luna-high', route: 'codex' };
    });
    checkPhase.mockImplementation(async (opts) => {
      opts.log('fail', 'checkers failed');
      return { passed: false, summary: SUMMARY, reworkRounds: 1, failureSignature: 'sig' };
    });

    const outcome = await runIssue(request, policy, ports);

    const expected = {
      plan: { model: 'claude-opus-5-5', provider: 'anthropic', effort: 'high' },
      build: { model: 'gpt-6-luna-high', provider: 'openai', effort: 'xhigh' },
      endedIn: 'check',
    };
    const fails = callsOf(log, 'fail');
    // The phase's own 'fail' is demoted to a non-terminal 'check' event; runIssue logs the only terminal (#3435).
    expect(fails).toHaveLength(1);
    for (const call of fails) expect(call[2].attribution).toEqual(expected);
    expect(outcome).toMatchObject({ state: 'parked', reason: 'fail', attribution: expected });
  });

  it('a PLAN-written escalate carries attribution.plan and endedIn plan with no build key', async () => {
    const { ports, log, planPhase, buildPhase } = setup({ plan: 'claude-opus-5-5' });
    planPhase.mockImplementation(async (opts) => {
      await opts.router.run('plan', 'p', {});
      opts.log('escalate', 'too big');
      return { ...PLAN_OK, ok: false, escalate: 'too big' };
    });

    const outcome = await runIssue(request, policy, ports);

    const attribution = callsOf(log, 'escalate')[0][2].attribution;
    expect(attribution.plan.model).toBe('claude-opus-5-5');
    expect(attribution.endedIn).toBe('plan');
    expect('build' in attribution).toBe(false);
    expect(buildPhase).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ state: 'escalated', attribution });
  });

  it('the rework model wins attribution.build when rework runs on another model', async () => {
    const { ports, log, planPhase, buildPhase, checkPhase } = setup({
      build_claude: 'claude-opus-5-5',
      build_codex: 'gpt-6-luna-high',
    });
    planPhase.mockResolvedValue(PLAN_OK);
    buildPhase.mockImplementation(async (opts) => {
      await opts.router.run('build_claude', 'b', {});
      return { ok: true, model: 'claude-opus-5-5', route: 'claude' };
    });
    checkPhase.mockImplementation(async (opts) => {
      await opts.router.run('build_codex', 'rework', {});
      opts.log('fail', 'still failing');
      return { passed: false, summary: SUMMARY, reworkRounds: 1 };
    });

    await runIssue(request, policy, ports);

    const parked = callsOf(log, 'fail').at(-1)!;
    expect(parked[2].attribution.build.model).toBe('gpt-6-luna-high');
  });

  it('a model missing from the registry is attributed to provider unknown', async () => {
    const { ports, log, planPhase, buildPhase, checkPhase } = setup({ build_codex: 'mystery-model' });
    planPhase.mockResolvedValue(PLAN_OK);
    buildPhase.mockImplementation(async (opts) => {
      await opts.router.run('build_codex', 'b', {});
      return { ok: true, model: 'mystery-model', route: 'codex' };
    });
    checkPhase.mockResolvedValue({ passed: false, summary: SUMMARY, reworkRounds: 0 });

    await runIssue(request, policy, ports);

    expect(callsOf(log, 'fail').at(-1)![2].attribution.build).toEqual({ model: 'mystery-model', provider: 'unknown' });
  });

  it('a non-terminal event reaches the underlying log with exactly two arguments', async () => {
    const { ports, log, planPhase, buildPhase, checkPhase } = setup({});
    planPhase.mockResolvedValue(PLAN_OK);
    buildPhase.mockResolvedValue({ ok: true, model: 'm', route: 'codex' });
    checkPhase.mockImplementation(async (opts) => {
      opts.log('check', 'running checkers');
      return { passed: false, summary: SUMMARY, reworkRounds: 0 };
    });

    await runIssue(request, policy, ports);

    const call = callsOf(log, 'check').find((c) => c[1] === 'running checkers')!;
    expect(call).toHaveLength(2);
  });
});
