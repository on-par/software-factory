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
const tmp = tempDirs.makeSync('run-issue-brief-park-');
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
  sizeGateMode: 'file',
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

const BRIEF: WorkRequest = {
  id: 'local-brief:b.md#abc',
  kind: 'local-brief',
  title: 'T',
  brief: 'b',
  acceptanceCriteria: ['x'],
};
const briefRequest: RunRequest = {
  ...request,
  issue: 9_123_456,
  work: BRIEF,
  workSource: { kind: 'local-brief', params: { path: 'b.md' } },
};
const parkingPolicy: RunPolicy = { ...policy, budget: { perIssueCapUsd: 1 } };

function githubOctokit(reject?: Error) {
  const fail = reject ? async () => Promise.reject(reject) : undefined;
  const createComment = vi.fn(fail ?? (async (_args?: { body: string }) => ({ data: { id: 1 } })));
  const listComments = vi.fn(fail ?? (async () => ({ data: [] })));
  const updateComment = vi.fn();
  const getAuthenticated = vi.fn(async () => ({ data: { id: 9 } }));
  const octokit = Object.assign({} as Octokit, {
    rest: {
      users: { getAuthenticated },
      issues: { listComments, createComment, updateComment },
    },
  });
  return { octokit, createComment, listComments, updateComment, getAuthenticated };
}

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

describe('runIssue — park of a local-brief run', () => {
  it('a parked local-brief run makes no GitHub park-comment call', async () => {
    const { octokit, createComment, listComments, updateComment } = githubOctokit();
    const log = vi.fn<Log>();
    const parking: RunPorts = { ...ports(log, octokit), getIssueSpend: () => 2 };
    const outcome = await runIssue(briefRequest, parkingPolicy, parking);
    expect(outcome).toMatchObject({ state: 'parked', reason: 'fail' });
    expect(createComment).not.toHaveBeenCalled();
    expect(listComments).not.toHaveBeenCalled();
    expect(updateComment).not.toHaveBeenCalled();
    expect(log.mock.calls.some(([type, msg]) => type === 'fail' && /budget|cap/i.test(msg))).toBe(true);
  });

  it('a parked local-brief run logs no park-comment warning', async () => {
    const { octokit } = githubOctokit(Object.assign(new Error('Not Found'), { status: 404 }));
    const log = vi.fn<Log>();
    const parking: RunPorts = { ...ports(log, octokit), getIssueSpend: () => 2 };
    await runIssue(briefRequest, parkingPolicy, parking);
    expect(log.mock.calls.some(([type]) => type === 'environment_warning')).toBe(false);
    expect(log.mock.calls.some(([, msg]) => msg.includes('could not post the issue park comment'))).toBe(false);
  });

  it('a parked github-issue run still posts its park comment', async () => {
    const { octokit, createComment } = githubOctokit();
    const log = vi.fn<Log>();
    const parking: RunPorts = { ...ports(log, octokit), getIssueSpend: () => 2 };
    const outcome = await runIssue(request, parkingPolicy, parking);
    expect(outcome).toMatchObject({ state: 'parked' });
    expect(createComment).toHaveBeenCalledTimes(1);
    const parkEvent = log.mock.calls.find(([type]) => type === 'fail');
    const body = createComment.mock.calls[0]?.[0]?.body;
    expect(body).toContain(parkEvent?.[1] ?? 'missing');
  });
});
