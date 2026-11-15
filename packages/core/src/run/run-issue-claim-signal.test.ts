import { rmSync } from 'node:fs';
import { join } from 'node:path';

import type { Octokit } from '@octokit/rest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import type { BuildResult, buildPhase as realBuildPhase } from '../phases/build.js';
import type { CheckPhaseResult, checkPhase as realCheckPhase } from '../phases/check.js';
import type { PlanResult, planPhase as realPlanPhase } from '../phases/plan.js';
import type { ShipResult, shipPhase as realShipPhase } from '../phases/ship.js';
import { ProviderBreaker } from '../router/breaker.js';
import { ModelRouter } from '../router/index.js';
import { createTempDirs } from '../harness/temp-dir.js';
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
const CHECK_OK: CheckPhaseResult = {
  passed: true,
  summary: { failures: 0, passes: 1, skips: 0, total: 1, results: [] },
  reworkRounds: 0,
};

const WORK: WorkRequest = {
  id: 'github-issue:o/r#1',
  kind: 'github-issue',
  title: 'Fix the thing',
  brief: 'do the thing',
  acceptanceCriteria: [],
};

const tempDirs = createTempDirs();
const tmp = tempDirs.makeSync('run-issue-no-pr-');
afterAll(() => tempDirs.cleanup());
const keepsFile = join(tmp, 'worktree-keeps.json');

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
  readinessUpdateIssueBody: true,
  sizeGateMode: 'stack',
  worktreeKeepsPath: keepsFile,
};

const ROUTES: RoutesConfig = { version: 1, routes: {} };
const MODELS: ModelsConfig = {
  version: 1,
  models: {},
  tiers: {},
  failover: { triggers: [], maxRetries: 0, cooldownMs: 0 },
  routingRules: {},
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

type Log = ReturnType<RunPorts['events']>;

function ports(log: Log, octokit: Octokit = {} as Octokit): RunPorts {
  return {
    router: new ModelRouter(MODELS, ROUTES),
    octokit,
    workspace: { path: '/tmp/wt', dispose: async () => {} } as Workspace,
    events: () => log,
    breaker: new ProviderBreaker(join(tmp, 'breaker.json')),
    resolveConstitution: () => null,
    planPhase,
    buildPhase,
    checkPhase,
    shipPhase,
  };
}

beforeEach(() => {
  rmSync(keepsFile, { force: true });
  vi.mocked(shipPhase)
    .mockReset()
    .mockResolvedValue({ ok: true, prNumber: 42 } satisfies ShipResult);
  vi.mocked(planPhase).mockReset().mockResolvedValue(PLAN_OK);
  vi.mocked(buildPhase).mockReset().mockResolvedValue(BUILD_OK);
  vi.mocked(checkPhase).mockReset().mockResolvedValue(CHECK_OK);
});

describe('runIssue — claimSignal (#3146)', () => {
  it('an abort after BUILD stops at the SHIP boundary: shipPhase never runs, the error is rethrown, nothing parks', async () => {
    const controller = new AbortController();
    const lost = new Error('claim on #1 lost (released)');
    vi.mocked(buildPhase).mockImplementation(async () => {
      controller.abort(lost);
      return BUILD_OK;
    });
    const log = vi.fn<Log>();
    await expect(runIssue(request, policy, { ...ports(log), claimSignal: controller.signal })).rejects.toBe(lost);
    expect(shipPhase).not.toHaveBeenCalled();
    expect(log.mock.calls.some(([type]) => type === 'parked' || type === 'escalate')).toBe(false);
  });

  it('a signal that never aborts leaves the run unchanged', async () => {
    const controller = new AbortController();
    const outcome = await runIssue(request, policy, { ...ports(vi.fn<Log>()), claimSignal: controller.signal });
    expect(outcome).toMatchObject({ state: 'ready' });
    expect(shipPhase).toHaveBeenCalledTimes(1);
    expect(shipPhase.mock.calls[0][0].run).toBeTypeOf('function');
  });

  it('an abort during the first shipPhase rethrows even when ship reports ok:false', async () => {
    const controller = new AbortController();
    const lost = new Error('lost');
    vi.mocked(shipPhase).mockImplementation(async () => {
      controller.abort(lost);
      return { ok: false, reason: 'push refused' } as ShipResult;
    });
    await expect(runIssue(request, policy, { ...ports(vi.fn<Log>()), claimSignal: controller.signal })).rejects.toBe(
      lost,
    );
  });

  it('without a claimSignal shipPhase gets no guarded runner', async () => {
    await runIssue(request, policy, ports(vi.fn<Log>()));
    expect(shipPhase.mock.calls[0][0]).not.toHaveProperty('run');
  });
});
