// packages/core/src/run/run-issue.base-branch.test.ts — parentBaseRef from --base-branch reaches base health, CHECK and SHIP (#3764)

import { join } from 'node:path';

import type { Octokit } from '@octokit/rest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { checkBaseHealth as realCheckBaseHealth } from '../checkers/base-health.js';
import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import type { BuildResult, buildPhase as realBuildPhase } from '../phases/build.js';
import type { CheckPhaseResult, checkPhase as realCheckPhase } from '../phases/check.js';
import type { PlanResult, planPhase as realPlanPhase } from '../phases/plan.js';
import type { shipPhase as realShipPhase } from '../phases/ship.js';
import { createTempDirs } from '../harness/temp-dir.js';
import { ProviderBreaker } from '../router/breaker.js';
import { ModelRouter } from '../router/index.js';
import type { CheckSummary } from '../types/index.js';
import type { WorkRequest } from '../work/index.js';
import type { RunPolicy } from './policy.js';
import type { Workspace } from './ports.js';
import { runIssue, type RunPorts, type RunRequest } from './run-issue.js';

const planPhase = vi.fn<typeof realPlanPhase>();
const buildPhase = vi.fn<typeof realBuildPhase>();
const checkPhase = vi.fn<typeof realCheckPhase>();
const shipPhase = vi.fn<typeof realShipPhase>();
const checkBaseHealth = vi.fn<typeof realCheckBaseHealth>();

const PLAN_OK: PlanResult = { ok: true, route: 'codex', specPath: '/tmp/wt/spec.md', model: 'm', designArtifact: null };
const BUILD_OK: BuildResult = { ok: true, model: 'm', route: 'codex' };
const CHECK_SUMMARY: CheckSummary = { failures: 0, passes: 1, skips: 0, total: 1, results: [] };
const CHECK_OK: CheckPhaseResult = { passed: true, summary: CHECK_SUMMARY, reworkRounds: 0 };

const WORK: WorkRequest = {
  id: 'github-issue:o/r#1',
  kind: 'github-issue',
  title: 'Fix the thing',
  brief: 'do the thing',
  acceptanceCriteria: [],
};

const ROUTES: RoutesConfig = {
  version: 1,
  routes: { build_codex: { tier: 'worker', description: 'stub', requires: 'codex' } },
};

const MODELS: ModelsConfig = {
  version: 1,
  models: {},
  tiers: {},
  failover: { triggers: [], maxRetries: 0, cooldownMs: 0 },
  routingRules: {},
};

const tempDirs = createTempDirs();
const breakerDir = tempDirs.makeSync('run-issue-base-branch-');
afterAll(() => tempDirs.cleanup());
let breakerCounter = 0;

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

const request = (overrides: Partial<RunRequest> = {}): RunRequest => ({
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
  sizeGateMode: 'off',
  ...overrides,
});

function run(overrides: Partial<RunRequest>) {
  breakerCounter += 1;
  const ports: RunPorts = {
    router: new ModelRouter(MODELS, ROUTES),
    octokit: {} as Octokit,
    workspace: { path: '/tmp/wt', dispose: async () => {} } as Workspace,
    events: () => vi.fn(),
    breaker: new ProviderBreaker(join(breakerDir, `breaker-${breakerCounter}.json`)),
    resolveConstitution: () => null,
    planPhase,
    buildPhase,
    checkPhase,
    shipPhase,
    checkBaseHealth,
  };
  return runIssue(request(overrides), policy, ports);
}

beforeEach(() => {
  planPhase.mockReset().mockResolvedValue(PLAN_OK);
  buildPhase.mockReset().mockResolvedValue(BUILD_OK);
  checkPhase.mockReset().mockResolvedValue(CHECK_OK);
  shipPhase.mockReset().mockResolvedValue({ ok: true, prNumber: 7 });
  checkBaseHealth
    .mockReset()
    .mockResolvedValue({ kind: 'green', baseSha: 'a'.repeat(40), failingChecks: [], cached: false });
});

describe('runIssue — parentBaseRef from --base-branch (#3764)', () => {
  it('passes parentBaseRef to checkBaseHealth as baseRef', async () => {
    await run({ parentBaseRef: 'origin/feat/x' });
    expect(checkBaseHealth.mock.calls[0][0].baseRef).toBe('origin/feat/x');
  });

  it('passes the stripped parentBaseRef to shipPhase as baseBranch', async () => {
    await run({ parentBaseRef: 'origin/feat/x' });
    expect(shipPhase.mock.calls[0][0].baseBranch).toBe('feat/x');
  });

  it('passes parentBaseRef to checkPhase', async () => {
    await run({ parentBaseRef: 'origin/feat/x' });
    expect(checkPhase.mock.calls[0][0].parentBaseRef).toBe('origin/feat/x');
  });

  it('omits baseRef and baseBranch when parentBaseRef is unset', async () => {
    await run({});
    expect(checkBaseHealth.mock.calls[0][0]).not.toHaveProperty('baseRef');
    expect(shipPhase.mock.calls[0][0]).not.toHaveProperty('baseBranch');
  });
});
