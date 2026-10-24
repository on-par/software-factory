import { workKeyFromIssue } from '../work/work-key.js';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Octokit } from '@octokit/rest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { type BuildResult, buildPhase as realBuildPhase } from '../phases/build.js';
import type { CheckPhaseResult, checkPhase as realCheckPhase } from '../phases/check.js';
import { reworkWorker } from '../phases/check.js';
import type { PlanResult, planPhase as realPlanPhase } from '../phases/plan.js';
import type { ShipResult, shipPhase as realShipPhase } from '../phases/ship.js';
import { createTempDirs } from '../harness/temp-dir.js';
import { ProviderBreaker } from '../router/breaker.js';
import { type ModelExecutorContext, ModelRouter } from '../router/index.js';
import { StubModelExecutor } from '../router/stub.js';
import type { CheckSummary } from '../types/index.js';
import { readWorktreeKeeps } from '../utils/worktree-keeps.js';
import type { WorkRequest } from '../work/index.js';
import type { RunPolicy } from './policy.js';
import type { Workspace } from './ports.js';
import { runIssue, type RunPorts, type RunRequest } from './run-issue.js';

const planPhase = vi.fn<typeof realPlanPhase>();
const buildPhase = vi.fn<typeof realBuildPhase>();
const checkPhase = vi.fn<typeof realCheckPhase>();
const shipPhase = vi.fn<typeof realShipPhase>();

const PLAN_OK: PlanResult = { ok: true, route: 'codex', specPath: '/tmp/wt/spec.md', model: 'm', designArtifact: null };
const BUILD_OK: BuildResult = { ok: true, model: 'm', route: 'codex' };
const SUMMARY: CheckSummary = { failures: 0, passes: 1, skips: 0, total: 1, results: [] };
const CHECK_OK: CheckPhaseResult = { passed: true, summary: SUMMARY, reworkRounds: 0 };
const SHIP_OK: ShipResult = { ok: true, prNumber: 42 };
const WORK: WorkRequest = {
  id: 'github-issue:o/r#1',
  kind: 'github-issue',
  title: 'Fix the thing',
  brief: 'do the thing',
  acceptanceCriteria: [],
};
const ROUTES: RoutesConfig = { version: 1, routes: {} };

const dirs = createTempDirs();
const tmp = dirs.makeSync('budget-stop-');
afterAll(() => dirs.cleanup());
let counter = 0;
let spend = 1.21;

function request(): RunRequest {
  counter += 1;
  return {
    issue: workKeyFromIssue(3320),
    repo: 'o/r',
    branch: 'issue-3320-x',
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
    worktreeKeepsPath: join(tmp, `keeps-${counter}.json`),
  };
}

function policy(budget: RunPolicy['budget']): RunPolicy {
  return {
    models: {
      version: 1,
      models: {},
      tiers: {},
      failover: { triggers: [], maxRetries: 0, cooldownMs: 0 },
      routingRules: {},
    },
    routes: ROUTES,
    sandbox: {
      enabled: false,
      runtime: 'auto',
      codexFullAccessTasks: [],
      network: { allow: [] },
      resources: { cpuMs: 0, memMb: 0 },
      docker: { rolloutPercent: 0 },
    },
    budget,
    effective: {} as RunPolicy['effective'],
  };
}

function ports(messages: string[], dispose = vi.fn(async () => {})): RunPorts {
  return {
    router: new ModelRouter(
      {
        version: 1,
        models: {},
        tiers: {},
        failover: { triggers: [], maxRetries: 0, cooldownMs: 0 },
        routingRules: {},
      },
      ROUTES,
    ),
    octokit: {} as Octokit,
    workspace: { path: '/tmp/wt', dispose } as Workspace,
    events: () => (_type: string, msg: string) => {
      messages.push(msg);
    },
    breaker: new ProviderBreaker(join(tmp, `breaker-${counter}.json`)),
    resolveConstitution: () => null,
    getIssueSpend: () => spend,
    planPhase,
    buildPhase,
    checkPhase,
    shipPhase,
  };
}

const spawnChild = () =>
  spawn(process.execPath, ['-e', 'setTimeout(()=>{},30000)'], { detached: true, stdio: 'ignore' });
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

beforeEach(() => {
  spend = 1.21;
  vi.mocked(planPhase).mockReset().mockResolvedValue(PLAN_OK);
  vi.mocked(buildPhase).mockReset().mockResolvedValue(BUILD_OK);
  vi.mocked(checkPhase).mockReset().mockResolvedValue(CHECK_OK);
  vi.mocked(shipPhase).mockReset().mockResolvedValue(SHIP_OK);
});

describe.skipIf(process.platform === 'win32')('runIssue — mid-session budget stop (#3320)', () => {
  it('BUILD is stopped mid-session when running spend crosses the per-issue cap', { timeout: 10_000 }, async () => {
    const child = spawnChild();
    const exited = new Promise<string | null>((resolve) => child.once('exit', (_code, signal) => resolve(signal)));
    const pid = child.pid as number;
    let aliveAtFirstCall = false;
    vi.mocked(buildPhase).mockImplementation(async (opts) => {
      opts.onPgid?.(pid);
      const guard = opts.budgetGuard;
      if (!guard) {
        spend += 29;
        return BUILD_OK;
      }
      expect(guard(28.5, 182)).toBe(false);
      aliveAtFirstCall = alive(pid);
      expect(guard(29.0, 183)).toBe(true);
      await exited;
      return { ok: false, model: 'm', route: 'codex', reason: 'budget_exceeded' };
    });
    const messages: string[] = [];
    const dispose = vi.fn(async () => {});
    const req = request();
    const outcome = await runIssue(req, policy({ perIssueCapUsd: 30 }), ports(messages, dispose));
    expect(outcome).toMatchObject({ state: 'parked', reason: 'fail' });
    expect(messages.join('\n')).toContain(
      'per-issue budget exceeded during BUILD: $30.21 > $30.00 (stopped at model call 183)',
    );
    expect(aliveAtFirstCall).toBe(true);
    expect(await exited).toBe('SIGTERM');
    expect(checkPhase).not.toHaveBeenCalled();
    expect(readWorktreeKeeps(req.worktreeKeepsPath as string).map((k) => k.path)).toEqual(['/tmp/wt']);
    expect(dispose).not.toHaveBeenCalled();
    child.kill('SIGKILL');
  });

  it('a BUILD that never reports live usage still parks with the after-BUILD message', async () => {
    vi.mocked(buildPhase).mockImplementation(async () => {
      spend = 30.21;
      return BUILD_OK;
    });
    const messages: string[] = [];
    const outcome = await runIssue(request(), policy({ perIssueCapUsd: 30 }), ports(messages));
    expect(outcome).toMatchObject({ state: 'parked', reason: 'fail' });
    expect(messages.join('\n')).toContain('per-issue budget exceeded after BUILD: $30.21 > $30.00');
  });

  it('with no perIssueCapUsd no guard is passed and nothing is killed', async () => {
    const child = spawnChild();
    try {
      let guard: unknown = 'unset';
      let aliveDuringBuild = false;
      vi.mocked(buildPhase).mockImplementation(async (opts) => {
        opts.onPgid?.(child.pid as number);
        guard = opts.budgetGuard;
        await new Promise((resolve) => setTimeout(resolve, 100));
        aliveDuringBuild = alive(child.pid as number);
        return BUILD_OK;
      });
      const outcome = await runIssue(request(), policy({}), ports([]));
      expect(guard).toBeUndefined();
      expect(aliveDuringBuild).toBe(true);
      expect(outcome.state).toBe('ready');
    } finally {
      child.kill('SIGKILL');
    }
  });
});

const WORKER_MODELS: ModelsConfig = {
  version: 1,
  models: {
    'stub-codex': {
      provider: 'openai',
      tier: 'worker',
      costPerMtokInput: 3,
      costPerMtokOutput: 15,
      contextWindow: 1000,
      capabilities: ['codex'],
      envKey: null,
      codex: true,
    },
    'stub-worker': {
      provider: 'custom',
      tier: 'worker',
      costPerMtokInput: 3,
      costPerMtokOutput: 15,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
    },
  },
  tiers: { worker: ['stub-codex', 'stub-worker'] },
  failover: {
    triggers: ['rate_limit', 'unavailable', 'auth'],
    maxRetries: 2,
    cooldownMs: 0,
  },
  routingRules: {},
};
const WORKER_ROUTES: RoutesConfig = {
  version: 1,
  routes: {
    build_claude: { tier: 'worker', description: 'stub' },
    build_codex: { tier: 'worker', description: 'stub', requires: 'codex' },
  },
};

/** A router whose first build call reports live usage and returns; the guard then trips. */
function budgetRouter(): { router: ModelRouter; stub: StubModelExecutor } {
  const effect = (ctx: ModelExecutorContext) => ctx.onLiveUsage?.({ inputTokens: 10, outputTokens: 10, calls: 183 });
  const stub = new StubModelExecutor({
    scripts: {
      build_codex: [{ output: 'partial', effect }],
      build_claude: [{ output: 'claude', effect }],
    },
  });
  return { router: new ModelRouter(WORKER_MODELS, WORKER_ROUTES, false, stub), stub };
}

describe('buildPhase — budget stop (#3320)', () => {
  it('maps BudgetStopError to budget_exceeded without failing over', async () => {
    const worktree = dirs.makeSync('wt-');
    const specPath = join(worktree, 'spec.md');
    writeFileSync(specPath, '# spec');
    const { router, stub } = budgetRouter();
    const result = await realBuildPhase({
      issue: 1,
      repo: 'o/r',
      worktree,
      specPath,
      branch: 'issue-1',
      route: 'codex',
      router,
      constitution: null,
      log: () => {},
      budgetGuard: () => true,
    });
    expect(result).toMatchObject({ ok: false, model: 'stub-codex', route: 'codex', reason: 'budget_exceeded' });
    expect(stub.calls).toHaveLength(1);
  });
});

describe('reworkWorker — budget stop (#3320)', () => {
  it('reports budgetStopped for a BudgetStopError and logs no rework_model_failed', async () => {
    const { router, stub } = budgetRouter();
    const log = vi.fn();
    const result = await reworkWorker({
      issue: 1,
      worktree: dirs.makeSync('wt-'),
      specPath: '/tmp/s.md',
      summary: SUMMARY,
      constitution: null,
      router,
      log,
      budgetGuard: () => true,
    });
    expect(result).toEqual({ failovers: [], modelCompleted: false, budgetStopped: true });
    expect(log.mock.calls.map((c) => c[0])).not.toContain('rework_model_failed');
    expect(stub.calls).toHaveLength(1);
  });
});
