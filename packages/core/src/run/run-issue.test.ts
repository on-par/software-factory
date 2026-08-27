import type { Octokit } from '@octokit/rest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import type { BuildResult } from '../phases/build.js';
import type { CheckPhaseResult } from '../phases/check.js';
import type { PlanResult } from '../phases/plan.js';
import type { ShipResult } from '../phases/ship.js';
import { ProviderBreaker } from '../router/breaker.js';
import { ModelRouter } from '../router/index.js';
import type { CheckSummary, Constitution } from '../types/index.js';
import type { WorkRequest } from '../work/index.js';
import type { RunPolicy } from './policy.js';
import type { Environment, Workspace } from './ports.js';

vi.mock('../phases/plan.js', () => ({ planPhase: vi.fn() }));
vi.mock('../phases/build.js', () => ({ buildPhase: vi.fn() }));
vi.mock('../phases/check.js', () => ({ checkPhase: vi.fn() }));
vi.mock('../phases/ship.js', () => ({ shipPhase: vi.fn() }));

const { planPhase } = await import('../phases/plan.js');
const { buildPhase } = await import('../phases/build.js');
const { checkPhase } = await import('../phases/check.js');
const { shipPhase } = await import('../phases/ship.js');
const { runIssue } = await import('./run-issue.js');
import type { RunPorts, RunRequest } from './run-issue.js';

const PLAN_OK: PlanResult = { ok: true, route: 'codex', specPath: '/tmp/wt/spec.md', model: 'm', designArtifact: null };
const BUILD_OK: BuildResult = { ok: true, model: 'm', route: 'codex' };
const CHECK_SUMMARY: CheckSummary = { failures: 0, passes: 1, skips: 0, total: 1, results: [] };
const CHECK_OK: CheckPhaseResult = { passed: true, summary: CHECK_SUMMARY, reworkRounds: 0 };
const SHIP_OK: ShipResult = { ok: true, prNumber: 42 };

const WORK: WorkRequest = {
  id: 'github-issue:o/r#1',
  kind: 'github-issue',
  title: 'Fix the thing',
  brief: 'do the thing',
  acceptanceCriteria: [],
};

function baseRequest(overrides: Partial<RunRequest> = {}): RunRequest {
  return {
    issue: 1,
    repo: 'o/r',
    branch: 'issue-1-fix-the-thing',
    specPath: '/tmp/wt/spec.md',
    work: WORK,
    startedAt: '2026-01-01T00:00:00.000Z',
    options: { interactive: false, autoRework: true, approvePlan: false, sandboxDisabled: false },
    timeouts: { plan: 60, build: 60, check: 60, approval: 60 },
    modelPins: { sources: {} },
    codexDisabled: false,
    skipCI: false,
    failover: { enabled: false, cooldownMs: 60_000, fallbackModel: 'claude-sonnet-5' },
    efficiency: { maxReworkRounds: 1, fastPath: false },
    processGroupGraceMs: 50,
    ...overrides,
  };
}

const ROUTES: RoutesConfig = {
  version: 1,
  routes: {
    build_claude: { tier: 'worker', description: 'stub', requires: 'claude' },
    build_codex: { tier: 'worker', description: 'stub', requires: 'codex' },
  },
};

/** A real ModelRouter (matching the rest of core's tests, e.g. phases/build.test.ts)
 *  over a minimal in-memory model set — avoids hand-rolling a partial ModelRouter
 *  double, which the codebase's structural-typing lint forbids for a class this shaped. */
function fakeRouter(modelDefs: Record<string, { provider: string; codex?: boolean }> = {}): ModelRouter {
  const models: ModelsConfig = {
    version: 1,
    models: Object.fromEntries(
      Object.entries(modelDefs).map(([id, def]) => [
        id,
        {
          provider: def.provider as ModelsConfig['models'][string]['provider'],
          tier: 'worker',
          costPerMtokInput: 0,
          costPerMtokOutput: 0,
          contextWindow: 1000,
          capabilities: [],
          envKey: null,
          ...(def.codex ? { codex: true } : {}),
        },
      ]),
    ),
    tiers: { worker: Object.keys(modelDefs) },
    failover: { triggers: [], maxRetries: 0, cooldownMs: 0, escalateAfterTierExhausted: false },
    routingRules: {},
  };
  return new ModelRouter(models, ROUTES);
}

function basePolicy(overrides: Partial<RunPolicy> = {}): RunPolicy {
  return {
    models: {
      version: 1,
      models: {},
      tiers: {},
      failover: { triggers: [], maxRetries: 0, cooldownMs: 0, escalateAfterTierExhausted: false },
      routingRules: {},
    },
    routes: ROUTES,
    sandbox: { enabled: false, network: { allow: [] }, resources: { cpuMs: 0, memMb: 0 } },
    budget: {},
    effective: {} as RunPolicy['effective'],
    ...overrides,
  };
}

let breakerFileCounter = 0;

function basePorts(overrides: Partial<RunPorts> = {}): RunPorts {
  breakerFileCounter += 1;
  return {
    router: fakeRouter(),
    octokit: {} as Octokit,
    workspace: { path: '/tmp/wt', dispose: async () => {} } as Workspace,
    events: () => vi.fn(),
    breaker: new ProviderBreaker(`/tmp/run-issue-test-breaker-${breakerFileCounter}.json`),
    resolveConstitution: () => null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(planPhase).mockReset().mockResolvedValue(PLAN_OK);
  vi.mocked(buildPhase).mockReset().mockResolvedValue(BUILD_OK);
  vi.mocked(checkPhase).mockReset().mockResolvedValue(CHECK_OK);
  vi.mocked(shipPhase).mockReset().mockResolvedValue(SHIP_OK);
});

describe('runIssue — invariant 1: constitution resolved exactly once', () => {
  it('calls resolveConstitution exactly once, before BUILD, and passes the same value to every phase', async () => {
    const constitution: Constitution = {
      source: 'bundled',
      product: 'acme',
      version: 1,
      checkers: [],
      body: 'stds',
      path: '/tmp/acme.md',
      requireTests: true,
    };
    const resolveConstitution = vi.fn(() => constitution);
    const outcome = await runIssue(baseRequest(), basePolicy(), basePorts({ resolveConstitution }));

    expect(resolveConstitution).toHaveBeenCalledTimes(1);
    expect(outcome.state).toBe('ready');
    for (const call of [
      vi.mocked(planPhase).mock.calls[0],
      vi.mocked(buildPhase).mock.calls[0],
      vi.mocked(checkPhase).mock.calls[0],
    ]) {
      expect(call[0].constitution).toBe(constitution);
    }
  });
});

describe('runIssue — invariant 2: budget asserted after each phase', () => {
  it('parks with reason fail when the budget is already exceeded after PLAN', async () => {
    const outcome = await runIssue(
      baseRequest(),
      basePolicy({ budget: { perIssueCapUsd: 1 } }),
      basePorts({ getIssueSpend: () => 2 }),
    );
    expect(outcome).toMatchObject({ state: 'parked', reason: 'fail' });
    expect(buildPhase).not.toHaveBeenCalled();
  });

  it('parks with reason fail when the budget is exceeded after BUILD', async () => {
    let spend = 0;
    vi.mocked(planPhase).mockImplementation(async () => {
      spend = 2;
      return PLAN_OK;
    });
    const outcome = await runIssue(
      baseRequest(),
      basePolicy({ budget: { perIssueCapUsd: 1 } }),
      basePorts({ getIssueSpend: () => spend }),
    );
    expect(outcome).toMatchObject({ state: 'parked', reason: 'fail' });
    expect(checkPhase).not.toHaveBeenCalled();
  });

  it('parks with reason fail when the budget is exceeded after CHECK', async () => {
    let spend = 0;
    vi.mocked(checkPhase).mockImplementation(async () => {
      spend = 2;
      return CHECK_OK;
    });
    const outcome = await runIssue(
      baseRequest(),
      basePolicy({ budget: { perIssueCapUsd: 1 } }),
      basePorts({ getIssueSpend: () => spend }),
    );
    expect(outcome).toMatchObject({ state: 'parked', reason: 'fail' });
    expect(shipPhase).not.toHaveBeenCalled();
  });

  it('never parks when no cap is configured, regardless of spend', async () => {
    const outcome = await runIssue(
      baseRequest(),
      basePolicy({ budget: {} }),
      basePorts({ getIssueSpend: () => 1_000_000 }),
    );
    expect(outcome.state).toBe('ready');
  });
});

describe('runIssue — invariant 3: environment released exactly once', () => {
  function trackedEnvironment(): { env: Environment; release: ReturnType<typeof vi.fn> } {
    const release = vi.fn().mockResolvedValue(undefined);
    const env: Environment = { port: 4100, env: () => ({}), recordPgid: () => {}, release };
    return { env, release };
  }

  it('releases once on a successful (ready) run', async () => {
    const { env, release } = trackedEnvironment();
    await runIssue(baseRequest(), basePolicy(), basePorts({ acquireEnvironment: async () => env }));
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('releases once when the run parks', async () => {
    const { env, release } = trackedEnvironment();
    vi.mocked(checkPhase).mockResolvedValue({ passed: false, summary: CHECK_SUMMARY, reworkRounds: 1 });
    await runIssue(baseRequest(), basePolicy(), basePorts({ acquireEnvironment: async () => env }));
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('releases once when the run escalates', async () => {
    const { env, release } = trackedEnvironment();
    vi.mocked(planPhase).mockResolvedValue({ ...PLAN_OK, ok: false, escalate: 'bad' });
    await runIssue(baseRequest(), basePolicy(), basePorts({ acquireEnvironment: async () => env }));
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('releases once when a phase throws unexpectedly', async () => {
    const { env, release } = trackedEnvironment();
    vi.mocked(buildPhase).mockRejectedValue(new Error('boom'));
    await runIssue(baseRequest(), basePolicy(), basePorts({ acquireEnvironment: async () => env }));
    expect(release).toHaveBeenCalledTimes(1);
  });
});

describe('runIssue — invariant 4: a failed lease degrades instead of parking', () => {
  it('logs environment_lease_failed and continues with appPort undefined', async () => {
    const events: Array<[string, string]> = [];
    const log = vi.fn((type: string, msg: string) => events.push([type, msg]));
    const outcome = await runIssue(
      baseRequest(),
      basePolicy(),
      basePorts({
        events: () => log,
        acquireEnvironment: async () => {
          throw new Error('port exhausted');
        },
      }),
    );

    expect(outcome.state).toBe('ready');
    expect(events).toContainEqual([
      'environment_lease_failed',
      'port lease unavailable (port exhausted) — running without injected PORT',
    ]);
    expect(vi.mocked(buildPhase).mock.calls[0][0].appPort).toBeUndefined();
  });

  it('does not attempt acquisition at all when the port is not injected', async () => {
    const outcome = await runIssue(baseRequest(), basePolicy(), basePorts());
    expect(outcome.state).toBe('ready');
    expect(vi.mocked(buildPhase).mock.calls[0][0].appPort).toBeUndefined();
  });
});

describe('runIssue — invariant 5: one terminal event sequence matching the outcome', () => {
  it('emits a single ready event for a successful run', async () => {
    const events: string[] = [];
    const log = vi.fn((type: string) => events.push(type));
    const outcome = await runIssue(baseRequest(), basePolicy(), basePorts({ events: () => log }));
    expect(outcome.state).toBe('ready');
    expect(
      events.filter((t) => ['ready', 'fail', 'escalate', 'held', 'conflict', 'ci-failed', 'timeout'].includes(t)),
    ).toEqual(['ready']);
  });

  it('emits a single fail event for a parked (check-failed) run', async () => {
    const events: string[] = [];
    const log = vi.fn((type: string) => events.push(type));
    vi.mocked(checkPhase).mockResolvedValue({ passed: false, summary: CHECK_SUMMARY, reworkRounds: 1 });
    const outcome = await runIssue(baseRequest(), basePolicy(), basePorts({ events: () => log }));
    expect(outcome).toMatchObject({ state: 'parked', reason: 'fail' });
    expect(events.filter((t) => ['ready', 'fail', 'escalate', 'held'].includes(t))).toEqual(['fail']);
  });

  it('emits a single escalate event for an escalated (plan) run', async () => {
    const events: string[] = [];
    const log = vi.fn((type: string) => events.push(type));
    vi.mocked(planPhase).mockResolvedValue({ ...PLAN_OK, ok: false, escalate: 'nope' });
    const outcome = await runIssue(baseRequest(), basePolicy(), basePorts({ events: () => log }));
    expect(outcome.state).toBe('escalated');
    expect(events.filter((t) => ['ready', 'fail', 'escalate', 'held'].includes(t))).toEqual(['escalate']);
  });
});

describe('runIssue — outcome mapping', () => {
  it('maps a passing run to ready with the PR number from SHIP', async () => {
    const outcome = await runIssue(baseRequest(), basePolicy(), basePorts());
    expect(outcome).toMatchObject({ state: 'ready', route: 'codex', branch: 'issue-1-fix-the-thing', prNumber: 42 });
  });

  it('skips SHIP and maps to ready (no prNumber) for a local-only run', async () => {
    const outcome = await runIssue(baseRequest({ localOnly: true }), basePolicy(), basePorts());
    expect(outcome).toMatchObject({ state: 'ready' });
    expect((outcome as { prNumber?: number }).prNumber).toBeUndefined();
    expect(shipPhase).not.toHaveBeenCalled();
  });

  it('maps a crossRunStuck CHECK result to parked/held', async () => {
    vi.mocked(checkPhase).mockResolvedValue({
      passed: false,
      summary: CHECK_SUMMARY,
      reworkRounds: 1,
      stuck: true,
      crossRunStuck: true,
    });
    const outcome = await runIssue(baseRequest(), basePolicy(), basePorts());
    expect(outcome).toMatchObject({ state: 'parked', reason: 'held' });
  });

  it('maps a stuck (non-cross-run) CHECK result to parked/escalate', async () => {
    vi.mocked(checkPhase).mockResolvedValue({ passed: false, summary: CHECK_SUMMARY, reworkRounds: 1, stuck: true });
    const outcome = await runIssue(baseRequest(), basePolicy(), basePorts());
    expect(outcome).toMatchObject({ state: 'parked', reason: 'escalate' });
  });

  it('maps a denied SHIP to parked/escalate', async () => {
    vi.mocked(shipPhase).mockResolvedValue({ ok: false, denied: true, deniedReason: 'no' });
    const outcome = await runIssue(baseRequest(), basePolicy(), basePorts());
    expect(outcome).toMatchObject({ state: 'parked', reason: 'escalate' });
  });

  it('maps a failed (non-denied) SHIP to parked/fail', async () => {
    vi.mocked(shipPhase).mockResolvedValue({ ok: false });
    const outcome = await runIssue(baseRequest(), basePolicy(), basePorts());
    expect(outcome).toMatchObject({ state: 'parked', reason: 'fail' });
  });

  it('maps a BUILD escalation to escalated', async () => {
    vi.mocked(buildPhase).mockResolvedValue({ ok: false, model: 'm', route: 'codex', escalate: 'bad build' });
    const outcome = await runIssue(baseRequest(), basePolicy(), basePorts());
    expect(outcome).toMatchObject({ state: 'escalated', reason: 'build escalated: bad build' });
  });

  it('classifies an unexpected thrown error structurally via parkReasonFor', async () => {
    vi.mocked(buildPhase).mockRejectedValue(Object.assign(new Error('timed out'), { reason: 'timeout' }));
    const outcome = await runIssue(baseRequest(), basePolicy(), basePorts());
    expect(outcome).toMatchObject({ state: 'parked', reason: 'timeout' });
  });
});

describe('runIssue — decomposition', () => {
  it('invokes onDecomposed and rethrows its signal instead of treating it as a park', async () => {
    vi.mocked(planPhase).mockResolvedValue({ ...PLAN_OK, ok: false, decomposed: { childIssues: [2, 3] } });
    const onDecomposed = vi.fn(() => {
      const err = new Error('decomposed') as Error & { childIssues: number[] };
      err.childIssues = [2, 3];
      throw err;
    });
    await expect(runIssue(baseRequest(), basePolicy(), basePorts({ onDecomposed }))).rejects.toThrow('decomposed');
    expect(onDecomposed).toHaveBeenCalledWith([2, 3]);
    expect(buildPhase).not.toHaveBeenCalled();
  });

  it('returns an escalated outcome when the decompose hook does not throw', async () => {
    vi.mocked(planPhase).mockResolvedValue({ ...PLAN_OK, ok: false, decomposed: { childIssues: [2] } });
    const outcome = await runIssue(baseRequest(), basePolicy(), basePorts({ onDecomposed: vi.fn() }));
    expect(outcome).toMatchObject({ state: 'escalated' });
  });
});

describe('runIssue — reporting hooks', () => {
  it('writes a local run report and benchmark artifacts on every parked exit', async () => {
    vi.mocked(checkPhase).mockResolvedValue({ passed: false, summary: CHECK_SUMMARY, reworkRounds: 1 });
    const writeLocalRunReport = vi.fn().mockResolvedValue('/tmp/report.md');
    const writeBenchmarkArtifacts = vi.fn().mockResolvedValue(undefined);
    await runIssue(baseRequest(), basePolicy(), basePorts({ writeLocalRunReport, writeBenchmarkArtifacts }));
    expect(writeLocalRunReport).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed' }));
    expect(writeBenchmarkArtifacts).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'failed', reportPath: '/tmp/report.md' }),
    );
  });

  it('records and clears rework history around a passing CHECK', async () => {
    const reworkHistory = {
      priorSignature: vi.fn().mockResolvedValue(undefined),
      record: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
    };
    await runIssue(baseRequest(), basePolicy(), basePorts({ reworkHistory: reworkHistory as never }));
    expect(reworkHistory.priorSignature).toHaveBeenCalledWith(1);
    expect(reworkHistory.clear).toHaveBeenCalledWith(1);
    expect(reworkHistory.record).not.toHaveBeenCalled();
  });

  it('records rework history when CHECK fails with a failure signature', async () => {
    vi.mocked(checkPhase).mockResolvedValue({
      passed: false,
      summary: { ...CHECK_SUMMARY, results: [{ checker: 'tests', result: 'FAIL', details: 'nope' }] },
      reworkRounds: 1,
      failureSignature: 'sig-1',
    });
    const reworkHistory = {
      priorSignature: vi.fn().mockResolvedValue(undefined),
      record: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
    };
    await runIssue(baseRequest(), basePolicy(), basePorts({ reworkHistory: reworkHistory as never }));
    expect(reworkHistory.record).toHaveBeenCalledWith(1, 'sig-1', ['tests']);
    expect(reworkHistory.clear).not.toHaveBeenCalled();
  });
});

describe('runIssue — interactive steering, proxy, and pgid tracking', () => {
  it('drains steering during BUILD and logs steering_applied when messages are present', async () => {
    const events: Array<[string, string]> = [];
    const log = vi.fn((type: string, msg: string) => events.push([type, msg]));
    const drainSteering = vi.fn(() => ({
      messages: [{ id: 's1', issue: 1, text: 'do X', queuedAt: '2026-01-01T00:00:00.000Z' }],
      attachments: [],
    }));
    const outcome = await runIssue(
      baseRequest({ options: { interactive: true, autoRework: true, approvePlan: false, sandboxDisabled: false } }),
      basePolicy(),
      basePorts({ events: () => log, drainSteering }),
    );
    expect(outcome.state).toBe('ready');
    expect(drainSteering).toHaveBeenCalled();
    expect(events.some(([t, m]) => t === 'steering_applied' && m.includes('s1'))).toBe(true);
    expect(vi.mocked(buildPhase).mock.calls[0][0].steering?.messages).toEqual([
      { id: 's1', issue: 1, text: 'do X', queuedAt: '2026-01-01T00:00:00.000Z' },
    ]);
  });

  it('logs the resolved proxy note when resolveBaseUrl returns one', async () => {
    const events: Array<[string, string]> = [];
    const log = vi.fn((type: string, msg: string) => events.push([type, msg]));
    const resolveBaseUrl = vi.fn(() => ({ baseUrl: 'https://lane.example.test', note: 'stable lane URL' }));
    await runIssue(baseRequest(), basePolicy(), basePorts({ events: () => log, resolveBaseUrl }));
    expect(events).toContainEqual(['environment_proxy', 'stable lane URL']);
    expect(vi.mocked(buildPhase).mock.calls[0][0].appBaseUrl).toBe('https://lane.example.test');
  });

  it('tracks a pgid reported through onPgid in both the tracker and the environment', async () => {
    const recordPgid = vi.fn();
    const environment: Environment = {
      port: 4100,
      env: () => ({}),
      recordPgid,
      release: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(buildPhase).mockImplementation(async (opts) => {
      opts.onPgid?.(4321);
      return BUILD_OK;
    });
    const outcome = await runIssue(
      baseRequest(),
      basePolicy(),
      basePorts({ acquireEnvironment: async () => environment }),
    );
    expect(outcome.state).toBe('ready');
    expect(recordPgid).toHaveBeenCalledWith(4321);
  });
});

describe('runIssue — provider breaker and failover', () => {
  it('opens the breaker and logs provider_breaker_open when a phase reports a provider failure', async () => {
    const events: Array<[string, string]> = [];
    const log = vi.fn((type: string, msg: string) => events.push([type, msg]));
    vi.mocked(planPhase).mockImplementation(async (opts) => {
      await opts.onProviderFailure?.({ provider: 'anthropic', reason: 'usage_cap' });
      return PLAN_OK;
    });
    const breaker = new ProviderBreaker(`/tmp/run-issue-test-breaker-provider-fail.json`);
    const outcome = await runIssue(baseRequest(), basePolicy(), basePorts({ events: () => log, breaker }));
    expect(outcome.state).toBe('ready');
    expect(events.some(([t, m]) => t === 'provider_breaker_open' && m.includes('anthropic'))).toBe(true);
    const status = await breaker.status('anthropic');
    expect(status.open).toBe(true);
  });

  it('honors a provider-reported reset time over the default cooldown', async () => {
    vi.mocked(planPhase).mockImplementation(async (opts) => {
      await opts.onProviderFailure?.({
        provider: 'anthropic',
        reason: 'usage_cap',
        detail: 'Resets in 3hr 17min.',
      });
      return PLAN_OK;
    });
    const breaker = new ProviderBreaker(`/tmp/run-issue-test-breaker-reset-hint.json`);
    await runIssue(
      baseRequest({ failover: { enabled: false, cooldownMs: 999, fallbackModel: 'x' } }),
      basePolicy(),
      basePorts({ breaker }),
    );
    const status = await breaker.status('anthropic');
    expect(status.open).toBe(true);
    if (status.open) expect(status.remainingMs).toBeGreaterThan(3 * 60 * 60_000);
  });

  it('gates BUILD on an open codex breaker and reroutes a claude plan to its codex fallback', async () => {
    vi.mocked(planPhase).mockResolvedValue({ ...PLAN_OK, route: 'claude' });
    const breaker = new ProviderBreaker(`/tmp/run-issue-test-breaker-gate.json`);
    await breaker.open('anthropic', 'usage_cap', 60_000);
    const router = fakeRouter({
      'claude-build': { provider: 'anthropic' },
      'gpt-build': { provider: 'openai', codex: true },
    });
    const request = baseRequest({
      failover: { enabled: true, cooldownMs: 60_000, fallbackModel: 'claude-sonnet-5' },
    });
    await runIssue(request, basePolicy(), basePorts({ breaker, router }));
    expect(vi.mocked(buildPhase).mock.calls[0][0]).toMatchObject({ route: 'codex', modelOverride: 'gpt-build' });
  });

  it('ignores an override model incompatible with its route and logs model_override_ignored', async () => {
    const events: Array<[string, string]> = [];
    const log = vi.fn((type: string, msg: string) => events.push([type, msg]));
    const router = fakeRouter({ 'claude-only-model': { provider: 'anthropic' } });
    const request = baseRequest({ modelPins: { build: 'claude-only-model', sources: {} } });
    await runIssue(request, basePolicy(), basePorts({ events: () => log, router }));
    expect(events.some(([t, m]) => t === 'model_override_ignored' && m.includes('claude-only-model'))).toBe(true);
    expect(vi.mocked(buildPhase).mock.calls[0][0].modelOverride).toBeUndefined();
  });
});
