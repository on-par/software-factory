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
import { readWorktreeKeeps } from '../utils/worktree-keeps.js';
import type { CheckResumeStore } from './resume-context.js';
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
const noPr: RunRequest = { ...request, noPr: true };

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

function githubOctokit() {
  const createComment = vi.fn(async () => ({ data: { id: 1 } }));
  const getAuthenticated = vi.fn(async () => ({ data: { id: 9 } }));
  const octokit = Object.assign({} as Octokit, {
    rest: {
      users: { getAuthenticated },
      issues: { listComments: vi.fn(async () => ({ data: [] })), createComment, updateComment: vi.fn() },
    },
  });
  return { octokit, createComment, getAuthenticated };
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

describe('runIssue — --no-pr', () => {
  it('stops after a clean CHECK: no SHIP, ready on the branch, no-pr-complete logged', async () => {
    const log = vi.fn<Log>();
    const outcome = await runIssue(noPr, policy, ports(log));
    expect(outcome).toMatchObject({ state: 'ready', route: 'codex', branch: request.branch, reworkRounds: 0 });
    expect(shipPhase).not.toHaveBeenCalled();
    const done = log.mock.calls.filter(([type]) => type === 'no-pr-complete');
    expect(done).toHaveLength(1);
    expect(done[0][1]).toContain('/tmp/wt');
  });

  it('a normal run still ships (control)', async () => {
    await runIssue(request, policy, ports(vi.fn<Log>()));
    expect(shipPhase).toHaveBeenCalledTimes(1);
  });

  it('keeps the worktree from GC with a keep record', async () => {
    await runIssue(noPr, policy, ports(vi.fn<Log>()));
    expect(readWorktreeKeeps(keepsFile)).toEqual([
      expect.objectContaining({ issue: 1, path: '/tmp/wt', reason: 'no-pr run' }),
    ]);
  });

  it('turns off BUILD publishing, the size gate, and the issue-body update', async () => {
    await runIssue(noPr, policy, ports(vi.fn<Log>()));
    expect(buildPhase.mock.calls[0][0]).toMatchObject({ disablePublish: true });
    expect(planPhase.mock.calls[0][0]).toMatchObject({ enforceSizeGate: false, updateIssueBodyOnEnrich: false });
    // localOnly also switches routing and prompts; --no-pr must not.
    expect(buildPhase.mock.calls[0][0].localOnly).toBeFalsy();
  });

  it('a red-base CHECK failure records no check-resume point, so resume can never ship it', async () => {
    vi.mocked(checkPhase).mockResolvedValue({
      ...CHECK_OK,
      passed: false,
      environment: { baseSha: 'abc1234567890def', failingChecks: ['tests'], cause: 'environment', logPaths: [] },
    });
    const checkResume = {
      load: vi.fn<CheckResumeStore['load']>().mockResolvedValue(null),
      record: vi.fn<CheckResumeStore['record']>().mockResolvedValue(undefined),
      clear: vi.fn<CheckResumeStore['clear']>().mockResolvedValue(undefined),
    };
    const outcome = await runIssue(noPr, policy, { ...ports(vi.fn<Log>()), checkResume });
    expect(outcome).not.toHaveProperty('buildPreserved');
    expect(checkResume.record).not.toHaveBeenCalled();
  });

  it('a failed keep-record write warns but the run still ends ready', async () => {
    const log = vi.fn<Log>();
    const unwritable = { ...noPr, worktreeKeepsPath: join(tmp, 'missing-dir', 'keeps.json', 'x') };
    rmSync(join(tmp, 'missing-dir'), { recursive: true, force: true });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(tmp, 'missing-dir'), 'a file, so the keeps dir cannot be created');
    const outcome = await runIssue(unwritable, policy, ports(log));
    expect(outcome).toMatchObject({ state: 'ready' });
    expect(log.mock.calls.some(([type, msg]) => type === 'warn' && msg.includes('keep record'))).toBe(true);
  });

  it('a park posts no issue comment', async () => {
    const { octokit, createComment, getAuthenticated } = githubOctokit();
    const parking: RunPorts = { ...ports(vi.fn<Log>(), octokit), getIssueSpend: () => 2 };
    const outcome = await runIssue(noPr, { ...policy, budget: { perIssueCapUsd: 1 } }, parking);
    expect(outcome).toMatchObject({ state: 'parked' });
    expect(createComment).not.toHaveBeenCalled();
    expect(getAuthenticated).not.toHaveBeenCalled();
  });
});
