import { workKeyFromIssue } from '../work/work-key.js';
import { join } from 'node:path';

import type { Octokit } from '@octokit/rest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import type { BuildResult, buildPhase as realBuildPhase } from '../phases/build.js';
import type { CheckPhaseResult, checkPhase as realCheckPhase } from '../phases/check.js';
import type { PlanResult, planPhase as realPlanPhase } from '../phases/plan.js';
import type { shipPhase as realShipPhase } from '../phases/ship.js';
import { createTempDirs } from '../harness/temp-dir.js';
import { ProviderBreaker } from '../router/breaker.js';
import { ModelRouter } from '../router/index.js';
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

const request: RunRequest = {
  issue: workKeyFromIssue(1),
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

const tempDirs = createTempDirs();
const breakerDir = tempDirs.makeSync('run-issue-env-release-');
afterAll(() => tempDirs.cleanup());

type Log = ReturnType<RunPorts['events']>;

function ports(log: Log, octokit: Octokit = {} as Octokit): RunPorts {
  return {
    router: new ModelRouter(MODELS, ROUTES),
    octokit,
    workspace: { path: '/tmp/wt', dispose: async () => {} } as Workspace,
    events: () => log,
    breaker: new ProviderBreaker(join(breakerDir, 'breaker.json')),
    resolveConstitution: () => null,
    planPhase,
    buildPhase,
    checkPhase,
    shipPhase,
  };
}

beforeEach(() => {
  vi.mocked(shipPhase).mockReset();
  vi.mocked(planPhase).mockReset().mockResolvedValue(PLAN_OK);
  vi.mocked(buildPhase).mockReset().mockResolvedValue(BUILD_OK);
  vi.mocked(checkPhase).mockReset().mockResolvedValue(CHECK_OK);
});

const ENV_FAIL: CheckPhaseResult = {
  ...CHECK_OK,
  passed: false,
  environment: { baseSha: 'abc1234567890def', failingChecks: ['tests'], cause: 'environment', logPaths: [] },
};

function statefulOctokit() {
  const store: Array<{ id: number; body: string; user: { id: number } }> = [];
  const createComment = vi.fn(async ({ body }: { body: string }) => {
    const c = { id: store.length + 1, body, user: { id: 9 } };
    store.push(c);
    return { data: c };
  });
  const updateComment = vi.fn(async ({ comment_id, body }: { comment_id: number; body: string }) => {
    const c = store.find((x) => x.id === comment_id);
    if (c) c.body = body;
    return { data: c };
  });
  const octokit = Object.assign({} as Octokit, {
    rest: {
      users: { getAuthenticated: vi.fn(async () => ({ data: { id: 9 } })) },
      issues: { listComments: vi.fn(async () => ({ data: [...store] })), createComment, updateComment },
    },
  });
  return { octokit, store, createComment, updateComment };
}

describe('runIssue — environment release comment (#3440)', () => {
  it('two environment releases on one issue leave one marker comment, updated', async () => {
    vi.mocked(checkPhase).mockResolvedValue(ENV_FAIL);
    const { octokit, store, createComment, updateComment } = statefulOctokit();
    await runIssue(request, policy, ports(vi.fn<Log>(), octokit));
    await runIssue(request, policy, ports(vi.fn<Log>(), octokit));
    const released = store.filter((c) => c.body.includes('factory-environment-release'));
    expect(store).toHaveLength(1);
    expect(released).toHaveLength(1);
    expect(createComment).toHaveBeenCalledTimes(1);
    expect(updateComment).toHaveBeenCalledTimes(1);
  });
});
