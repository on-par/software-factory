import type { Octokit } from '@octokit/rest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { BuildResult } from '../phases/build.js';
import type { CheckPhaseResult } from '../phases/check.js';
import type { PlanResult } from '../phases/plan.js';
import type { ShipResult } from '../phases/ship.js';
import { ProviderBreaker } from '../router/breaker.js';
import type { ModelRouter } from '../router/index.js';
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

function fakeRouter(): ModelRouter {
  return {
    resolveAll: () => [],
    registryRef: {
      get: () => undefined,
      getHarnessId: () => 'claude-cli',
      isCodexModel: () => false,
    },
  } as unknown as ModelRouter;
}

function basePolicy(overrides: Partial<RunPolicy> = {}): RunPolicy {
  return {
    models: {} as RunPolicy['models'],
    routes: {} as RunPolicy['routes'],
    sandbox: undefined as unknown as RunPolicy['sandbox'],
    budget: {},
    effective: {} as RunPolicy['effective'],
    ...overrides,
  };
}

function basePorts(overrides: Partial<RunPorts> = {}): RunPorts {
  return {
    router: fakeRouter(),
    octokit: {} as Octokit,
    workspace: { path: '/tmp/wt', dispose: async () => {} } as Workspace,
    events: () => vi.fn(),
    breaker: new ProviderBreaker('/tmp/does-not-exist-breaker.json'),
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
    for (const call of [vi.mocked(planPhase).mock.calls[0], vi.mocked(buildPhase).mock.calls[0], vi.mocked(checkPhase).mock.calls[0]]) {
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
    const outcome = await runIssue(baseRequest(), basePolicy({ budget: {} }), basePorts({ getIssueSpend: () => 1_000_000 }));
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
    expect(events).toContainEqual(['environment_lease_failed', 'port lease unavailable (port exhausted) — running without injected PORT']);
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
    expect(events.filter((t) => ['ready', 'fail', 'escalate', 'held', 'conflict', 'ci-failed', 'timeout'].includes(t))).toEqual([
      'ready',
    ]);
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
    expect(writeBenchmarkArtifacts).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed', reportPath: '/tmp/report.md' }));
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
