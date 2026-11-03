import { join } from 'node:path';

import { vi } from 'vitest';

import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import type { BuildResult, buildPhase as realBuildPhase } from '../phases/build.js';
import type { CheckPhaseResult, checkPhase as realCheckPhase } from '../phases/check.js';
import type { PlanResult, planPhase as realPlanPhase } from '../phases/plan.js';
import type { shipPhase as realShipPhase } from '../phases/ship.js';
import { createFakeGitHub } from '../fakes/fake-github.js';
import { ProviderBreaker } from '../router/breaker.js';
import { createTempDirs } from '../harness/temp-dir.js';
import { ModelRouter } from '../router/index.js';
import type { WorkRequest } from '../work/index.js';
import type { RunPolicy } from './policy.js';
import type { reworkWorker as realReworkWorker } from '../phases/check.js';
import type { RunPorts, RunRequest } from './run-issue.js';

export const planPhase = vi.fn<typeof realPlanPhase>();
export const buildPhase = vi.fn<typeof realBuildPhase>();
export const checkPhase = vi.fn<typeof realCheckPhase>();
export const shipPhase = vi.fn<typeof realShipPhase>();
export const reworkWorker = vi.fn<typeof realReworkWorker>();
export const readWorktreeHead = vi.fn<(worktree: string) => Promise<string>>();
export const readReworkDiff = vi.fn<(worktree: string, fromSha: string) => Promise<string>>();
export const mergeBaseIntoWorktree = vi.fn<NonNullable<RunPorts['mergeBaseIntoWorktree']>>();
export const collectFailingJobLogs = vi.fn<NonNullable<RunPorts['collectFailingJobLogs']>>();
export const listPrChangedFiles = vi.fn<NonNullable<RunPorts['listPrChangedFiles']>>();
export const listBaseFailingChecks = vi.fn<NonNullable<RunPorts['listBaseFailingChecks']>>();
export const listBaseCodeqlAlerts = vi.fn<NonNullable<RunPorts['listBaseCodeqlAlerts']>>();

export const PLAN_OK: PlanResult = {
  ok: true,
  route: 'codex',
  specPath: '/tmp/wt/spec.md',
  model: 'm',
  designArtifact: null,
};
export const BUILD_OK: BuildResult = { ok: true, model: 'm', route: 'codex' };
export const CHECK_OK: CheckPhaseResult = {
  passed: true,
  summary: { failures: 0, passes: 1, skips: 0, total: 1, results: [] },
  reworkRounds: 0,
};

export const WORK: WorkRequest = {
  id: 'github-issue:o/r#1',
  kind: 'github-issue',
  title: 'Fix the thing',
  brief: 'do the thing',
  acceptanceCriteria: [],
};

export const request: RunRequest = {
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

export const ROUTES: RoutesConfig = { version: 1, routes: {} };
export const MODELS: ModelsConfig = {
  version: 1,
  models: {},
  tiers: {},
  failover: { triggers: [], maxRetries: 0, cooldownMs: 0 },
  routingRules: {},
};

export const policy: RunPolicy = {
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
  effective: { localOnly: false, allowExperimental: false, codexDisabled: false, branchPrefix: 'issue-' },
};

export const tmp = createTempDirs();
export const breakerDir = tmp.makeSync('run-issue-ci-rework-');

const { octokit } = createFakeGitHub([]);

export type Log = ReturnType<RunPorts['events']>;

export function ports(log: Log): RunPorts {
  return {
    router: new ModelRouter(MODELS, ROUTES),
    octokit,
    workspace: { path: '/tmp/wt', dispose: async () => {} },
    events: () => log,
    breaker: new ProviderBreaker(join(breakerDir, 'breaker.json')),
    resolveConstitution: () => null,
    planPhase,
    buildPhase,
    checkPhase,
    shipPhase,
    reworkWorker,
    readWorktreeHead,
    readReworkDiff,
    listPrChangedFiles,
    listBaseFailingChecks,
    listBaseCodeqlAlerts,
    mergeBaseIntoWorktree,
    collectFailingJobLogs,
  };
}

export function resetCiReworkMocks(): void {
  vi.mocked(planPhase).mockReset().mockResolvedValue(PLAN_OK);
  vi.mocked(buildPhase).mockReset().mockResolvedValue(BUILD_OK);
  vi.mocked(checkPhase).mockReset().mockResolvedValue(CHECK_OK);
  shipPhase.mockReset();
  reworkWorker.mockReset().mockResolvedValue({ failovers: [], modelCompleted: true });
  readWorktreeHead.mockReset().mockResolvedValue('a'.repeat(40));
  readReworkDiff.mockReset().mockResolvedValue('');
  listPrChangedFiles.mockReset().mockResolvedValue(['packages/core/src/sandbox/egress-proxy.ts']);
  listBaseFailingChecks.mockReset().mockResolvedValue({ baseRef: 'main', baseSha: 'b'.repeat(40), failing: [] });
  listBaseCodeqlAlerts.mockReset().mockResolvedValue({ baseRef: 'main', numbers: [], refs: [] });
  mergeBaseIntoWorktree.mockReset().mockResolvedValue({ ok: true, merged: true });
  collectFailingJobLogs.mockReset().mockResolvedValue({
    jobLogs: [
      { name: 'test (2/3)', jobId: 7, excerpt: 'FAIL scripts/x.test.ts expected 1 to be 78', truncated: false },
    ],
    errors: [],
  });
}
