import { workKeyFromIssue } from '../work/work-key.js';
import { join } from 'node:path';

import type { Octokit } from '@octokit/rest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import type { buildPhase as realBuildPhase } from '../phases/build.js';
import type { checkPhase as realCheckPhase } from '../phases/check.js';
import type { planPhase as realPlanPhase } from '../phases/plan.js';
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
  pr: { draft: true },
};

const tempDirs = createTempDirs();
const breakerDir = tempDirs.makeSync('run-issue-park-pr-');
afterAll(() => tempDirs.cleanup());

type Log = ReturnType<RunPorts['events']>;

function prOctokit() {
  const createComment = vi.fn(async (_args: { issue_number: number; body: string }) => ({ data: { id: 1 } }));
  const update = vi.fn(async (_args: { state: string }) => ({ data: {} }));
  const deleteRef = vi.fn();
  const octokit = Object.assign({} as Octokit, {
    graphql: vi.fn(async () => ({})),
    rest: {
      users: { getAuthenticated: vi.fn(async () => ({ data: { id: 9 } })) },
      pulls: { list: vi.fn(async () => ({ data: [] })), get: vi.fn(), update },
      issues: { listComments: vi.fn(async () => ({ data: [] })), createComment, updateComment: vi.fn() },
      git: { deleteRef },
    },
  });
  return { octokit, createComment, update, deleteRef };
}

function ports(log: Log, octokit: Octokit): RunPorts {
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
  planPhase
    .mockReset()
    .mockResolvedValue({ ok: true, route: 'codex', specPath: '/tmp/wt/spec.md', model: 'm', designArtifact: null });
  buildPhase.mockReset().mockResolvedValue({ ok: true, model: 'm', route: 'codex' });
  checkPhase.mockReset().mockResolvedValue({
    passed: true,
    summary: { failures: 0, passes: 1, skips: 0, total: 1, results: [] },
    reworkRounds: 0,
  });
  shipPhase.mockReset();
});

describe('runIssue — a park settles the run PR (#3551)', () => {
  it("draft mode — a CI-failed park closes the run's draft PR and keeps the branch", async () => {
    shipPhase.mockResolvedValue({ ok: false, prNumber: 42, reason: 'CI failed for PR #42', ciOutcome: 'failure' });
    const { octokit, createComment, update, deleteRef } = prOctokit();
    const outcome = await runIssue(request, policy, ports(vi.fn<Log>(), octokit));
    expect(outcome).toMatchObject({ state: 'parked', reason: 'ci-failed', prNumber: 42 });
    const prComments = createComment.mock.calls.filter(([args]) => args.issue_number === 42);
    expect(prComments).toHaveLength(1);
    expect(prComments[0][0].body).toContain('ci-failed');
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ pull_number: 42, state: 'closed' }));
    expect(deleteRef).not.toHaveBeenCalled();
  });

  it('a park before SHIP makes no pulls.update call', async () => {
    buildPhase.mockRejectedValue(new Error('build exploded'));
    const { octokit, update } = prOctokit();
    const outcome = await runIssue(request, policy, ports(vi.fn<Log>(), octokit));
    expect(outcome.state).toBe('parked');
    expect(shipPhase).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});
