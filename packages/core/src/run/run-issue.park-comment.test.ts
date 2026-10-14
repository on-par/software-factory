import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

const ROUTES: RoutesConfig = { version: 1, routes: {} };
const MODELS: ModelsConfig = {
  version: 1,
  models: {},
  tiers: {},
  failover: { triggers: [], maxRetries: 0, cooldownMs: 0, escalateAfterTierExhausted: false },
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

const breakerDir = mkdtempSync(join(tmpdir(), 'run-issue-park-comment-'));
afterAll(() => rmSync(breakerDir, { recursive: true, force: true }));

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
  vi.mocked(shipPhase)
    .mockReset()
    .mockResolvedValue({ ok: true, prNumber: 42 } satisfies ShipResult);
  vi.mocked(planPhase).mockReset().mockResolvedValue(PLAN_OK);
  vi.mocked(buildPhase).mockReset().mockResolvedValue(BUILD_OK);
  vi.mocked(checkPhase).mockReset().mockResolvedValue(CHECK_OK);
});

const overBudget: RunPolicy = { ...policy, budget: { perIssueCapUsd: 1 } };

function commentOctokit(createComment = vi.fn(async (_args: { body: string }) => ({ data: { id: 1 } }))) {
  const getAuthenticated = vi.fn(async () => ({ data: { id: 9 } }));
  const octokit = Object.assign({} as Octokit, {
    rest: {
      users: { getAuthenticated },
      issues: { listComments: vi.fn(async () => ({ data: [] })), createComment, updateComment: vi.fn() },
    },
  });
  return { octokit, createComment, getAuthenticated };
}

function parkingPorts(log: Log, octokit?: Octokit): RunPorts {
  return { ...ports(log, octokit), getIssueSpend: () => 2 };
}

describe('runIssue — issue park comment (#2314)', () => {
  it('posts one marked comment on a park', async () => {
    const { octokit, createComment } = commentOctokit();
    const outcome = await runIssue(request, overBudget, parkingPorts(vi.fn<Log>(), octokit));
    expect(outcome).toMatchObject({ state: 'parked', reason: 'fail' });
    expect(createComment).toHaveBeenCalledTimes(1);
    const { body } = createComment.mock.calls[0][0];
    expect(body).toContain('issue:1 -->');
    expect(body).toContain('reason: fail');
  });

  it('a failing comment create leaves the parked outcome unchanged and logs environment_warning', async () => {
    const baseline = await runIssue(request, overBudget, parkingPorts(vi.fn<Log>()));
    const log = vi.fn<Log>();
    const { octokit } = commentOctokit(vi.fn().mockRejectedValue(new Error('403')));
    const outcome = await runIssue(request, overBudget, parkingPorts(log, octokit));
    expect(outcome).toEqual(baseline);
    const warnings = log.mock.calls.filter(
      ([type, message]) => type === 'environment_warning' && message.includes('park comment'),
    );
    expect(warnings).toHaveLength(1);
  });

  it('localOnly makes no octokit call', async () => {
    const { octokit, createComment, getAuthenticated } = commentOctokit();
    await runIssue({ ...request, localOnly: true }, overBudget, parkingPorts(vi.fn<Log>(), octokit));
    expect(createComment).not.toHaveBeenCalled();
    expect(getAuthenticated).not.toHaveBeenCalled();
  });

  it('parks blocked with no failure signature when a phase throws a blocked marker (#2315)', async () => {
    vi.mocked(buildPhase).mockRejectedValue(Object.assign(new Error('waiting on #9'), { parkReason: 'blocked' }));
    const log = vi.fn<Log>();
    const { octokit, createComment } = commentOctokit();
    const outcome = await runIssue(request, policy, ports(log, octokit));
    expect(outcome).toMatchObject({ state: 'parked', reason: 'blocked' });
    expect(outcome).not.toHaveProperty('failureSignature');
    expect(outcome).not.toHaveProperty('failingChecks');
    expect(log.mock.calls.map(([type]) => type)).toContain('blocked');
    expect(createComment.mock.calls[0][0].body).toContain('reason: blocked');
  });
});
