import { join } from 'node:path';

import type { Octokit } from '@octokit/rest';
import { afterAll, describe, expect, it, vi } from 'vitest';

import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { HarnessError } from '../harness/index.js';
import { createTempDirs } from '../harness/temp-dir.js';
import type { BuildResult, buildPhase as realBuildPhase } from '../phases/build.js';
import type { CheckPhaseResult, checkPhase as realCheckPhase } from '../phases/check.js';
import type { PlanResult, planPhase as realPlanPhase } from '../phases/plan.js';
import type { ShipResult, shipPhase as realShipPhase } from '../phases/ship.js';
import { ProviderBreaker } from '../router/breaker.js';
import { ModelRouter } from '../router/index.js';
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
  routes: { plan: { tier: 'planners', description: 'stub' } },
};

const HOUR = 60 * 60_000;

function modelsConfig(): ModelsConfig {
  const base = {
    tier: 'planners',
    costPerMtokInput: 0,
    costPerMtokOutput: 0,
    contextWindow: 1000,
    capabilities: [],
    envKey: null,
  };
  return {
    version: 1,
    models: {
      'claude-plan': { ...base, provider: 'anthropic' },
      'gpt-plan': { ...base, provider: 'openai' },
    },
    tiers: { planners: ['claude-plan', 'gpt-plan'] },
    failover: { triggers: ['usage_cap', 'rate_limit', 'unavailable'], maxRetries: 0, cooldownMs: 0 },
    routingRules: {},
  };
}

const tempDirs = createTempDirs();
const dir = tempDirs.makeSync('run-issue-provider-cap-');
afterAll(() => tempDirs.cleanup());
let counter = 0;

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
  failover: { enabled: true, cooldownMs: 60_000, fallbackModel: 'claude-sonnet-5' },
  efficiency: { maxReworkRounds: 1, fastPath: false },
  processGroupGraceMs: 50,
};

const policy: RunPolicy = {
  models: { version: 1, models: {}, tiers: {}, failover: request.failover as never, routingRules: {} } as never,
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

interface Setup {
  open?: Record<string, number>;
  failClaude?: HarnessError | Error;
  request?: Partial<RunRequest>;
}

async function run(setup: Setup = {}) {
  counter += 1;
  const breaker = new ProviderBreaker(join(dir, `breaker-${counter}.json`));
  for (const [provider, cooldownMs] of Object.entries(setup.open ?? {})) {
    await breaker.open(provider, 'usage_cap', cooldownMs);
  }
  const called: string[] = [];
  const events: Array<[string, string]> = [];
  const executor = {
    runModel: async (model: string) => {
      called.push(model);
      if (model === 'claude-plan' && setup.failClaude) throw setup.failClaude;
      return 'planned';
    },
  };
  const router = new ModelRouter(modelsConfig(), ROUTES, false, executor);
  const planPhase = vi.fn<typeof realPlanPhase>(async (opts) => {
    const result = await router.run('plan', 'p', {
      modelOverride: opts.modelOverride,
      modelFallbacks: opts.modelFallbacks,
      skipProviders: opts.skipProviders,
      onProviderFailure: opts.onProviderFailure,
      onLog: (msg) => opts.log('router', msg),
    });
    return {
      ok: true,
      route: 'claude',
      specPath: '/tmp/wt/spec.md',
      model: result.model,
      designArtifact: null,
    } satisfies PlanResult;
  });
  const buildPhase = vi
    .fn<typeof realBuildPhase>()
    .mockResolvedValue({ ok: true, model: 'm', route: 'claude' } satisfies BuildResult);
  const ports: RunPorts = {
    router,
    octokit: {} as Octokit,
    workspace: { path: '/tmp/wt', dispose: async () => {} } as Workspace,
    events: () => (type: string, msg: string) => events.push([type, msg]),
    breaker,
    resolveConstitution: () => null,
    planPhase,
    buildPhase,
    checkPhase: vi.fn<typeof realCheckPhase>().mockResolvedValue({
      passed: true,
      summary: { failures: 0, passes: 1, skips: 0, total: 1, results: [] },
      reworkRounds: 0,
    } satisfies CheckPhaseResult),
    shipPhase: vi.fn<typeof realShipPhase>().mockResolvedValue({ ok: true, prNumber: 42 } satisfies ShipResult),
  };
  const before = Date.now();
  const outcome = await runIssue({ ...request, ...setup.request }, policy, ports);
  return { outcome, called, events, planPhase, buildPhase, before, after: Date.now() };
}

const types = (events: Array<[string, string]>) => events.map(([t]) => t);

describe('runIssue — stage-boundary provider gate (#3226)', () => {
  it('PLAN skips an open provider and runs on the next configured one', async () => {
    const { outcome, called, events } = await run({ open: { anthropic: HOUR } });
    expect(called).toEqual(['gpt-plan']);
    expect(events.find(([t]) => t === 'provider_breaker_skip')?.[1]).toContain('anthropic');
    expect(outcome.state).toBe('ready');
    expect(types(events)).not.toContain('fail');
  });

  it('every plan provider timed-open releases provider-cap before any model call', async () => {
    const { outcome, called, events, planPhase, before, after } = await run({
      open: { anthropic: 2 * HOUR, openai: 4 * HOUR },
    });
    expect(outcome).toMatchObject({ state: 'released', reason: 'provider-cap', providers: ['anthropic', 'openai'] });
    const resetAt = Date.parse((outcome as { resetAt: string }).resetAt);
    expect(resetAt).toBeGreaterThanOrEqual(before + 2 * HOUR - 1000);
    expect(resetAt).toBeLessThanOrEqual(after + 2 * HOUR + 1000);
    expect(called).toEqual([]);
    expect(planPhase).not.toHaveBeenCalled();
    expect(types(events)).toContain('provider-cap-released');
    expect(types(events)).not.toContain('fail');
    expect(types(events)).not.toContain('escalate');
  });

  it('with auto_failover disabled an open first provider releases instead of failing over', async () => {
    const { outcome, called } = await run({
      open: { anthropic: HOUR },
      request: { failover: { ...request.failover, enabled: false } },
    });
    expect(outcome).toMatchObject({ state: 'released', reason: 'provider-cap', providers: ['anthropic'] });
    expect(called).toEqual([]);
  });

  it('a usage_cap PLAN failure that leaves every provider timed-open releases', async () => {
    const { outcome, called, events } = await run({
      open: { openai: 3 * HOUR },
      failClaude: new HarnessError('You have hit your usage limit', 'usage_cap'),
      request: { modelPins: { sources: {}, plan: 'claude-plan' } },
    });
    expect(called).toEqual(['claude-plan']);
    expect(outcome).toMatchObject({ state: 'released', reason: 'provider-cap' });
    expect(types(events)).not.toContain('fail');
  });

  it('a non-provider PLAN failure (error, schema_invalid) still parks fail', async () => {
    for (const reason of ['error', 'schema_invalid'] as const) {
      const { outcome } = await run({
        open: { openai: 3 * HOUR },
        failClaude: new HarnessError('boom', reason),
      });
      expect(outcome).toMatchObject({ state: 'parked', reason: 'fail' });
    }
  });

  it('all providers open on untimed reasons does not release', async () => {
    counter += 1;
    const breaker = new ProviderBreaker(join(dir, `breaker-${counter}.json`));
    await breaker.open('anthropic', 'timeout', HOUR);
    await breaker.open('openai', 'unavailable', HOUR);
    const executor = { runModel: async () => 'planned' };
    const router = new ModelRouter(modelsConfig(), ROUTES, false, executor);
    const planPhase = vi.fn<typeof realPlanPhase>().mockResolvedValue({
      ok: true,
      route: 'claude',
      specPath: '/tmp/wt/spec.md',
      model: 'm',
      designArtifact: null,
    } satisfies PlanResult);
    const ports: RunPorts = {
      router,
      octokit: {} as Octokit,
      workspace: { path: '/tmp/wt', dispose: async () => {} } as Workspace,
      events: () => () => {},
      breaker,
      resolveConstitution: () => null,
      planPhase,
      buildPhase: vi.fn<typeof realBuildPhase>().mockResolvedValue({ ok: true, model: 'm', route: 'claude' }),
      checkPhase: vi.fn<typeof realCheckPhase>().mockResolvedValue({
        passed: true,
        summary: { failures: 0, passes: 1, skips: 0, total: 1, results: [] },
        reworkRounds: 0,
      } satisfies CheckPhaseResult),
      shipPhase: vi.fn<typeof realShipPhase>().mockResolvedValue({ ok: true, prNumber: 42 } satisfies ShipResult),
    };
    const outcome = await runIssue(request, policy, ports);
    expect(outcome.state).not.toBe('released');
    expect(planPhase).toHaveBeenCalled();
    expect(planPhase.mock.calls[0][0].skipProviders).toBeUndefined();
  });

  it('a blocked BUILD releases before buildPhase when every build candidate is timed-open', async () => {
    counter += 1;
    const breaker = new ProviderBreaker(join(dir, `breaker-${counter}.json`));
    const router = new ModelRouter(
      { ...modelsConfig(), tiers: { planners: ['claude-plan', 'gpt-plan'], worker: ['claude-plan'] } },
      {
        version: 1,
        routes: {
          plan: { tier: 'planners', description: 'stub' },
          build_claude: { tier: 'worker', description: 'stub' },
        },
      },
      false,
      { runModel: async () => 'x' },
    );
    const buildPhase = vi.fn<typeof realBuildPhase>();
    const ports: RunPorts = {
      router,
      octokit: {} as Octokit,
      workspace: { path: '/tmp/wt', dispose: async () => {} } as Workspace,
      events: () => () => {},
      breaker,
      resolveConstitution: () => null,
      planPhase: vi.fn<typeof realPlanPhase>(async () => {
        await breaker.open('anthropic', 'usage_cap', HOUR);
        return { ok: true, route: 'claude', specPath: '/tmp/wt/spec.md', model: 'm', designArtifact: null };
      }),
      buildPhase,
    };
    const outcome = await runIssue({ ...request, failover: { ...request.failover, enabled: false } }, policy, ports);
    expect(outcome).toMatchObject({
      state: 'released',
      reason: 'provider-cap',
      providers: ['anthropic'],
      route: 'claude',
    });
    expect(buildPhase).not.toHaveBeenCalled();
  });
});
