import { join } from 'node:path';

import { createTempDirs } from '@on-par/factory-core/testing';
import type { Octokit } from '@octokit/rest';
import { afterAll, describe, expect, it, vi } from 'vitest';

import type { buildPhase as realBuildPhase } from '../phases/build.js';
import type { checkPhase as realCheckPhase } from '../phases/check.js';
import type { PlanResult, planPhase as realPlanPhase } from '../phases/plan.js';
import type { shipPhase as realShipPhase } from '../phases/ship.js';
import { ProviderBreaker } from '../router/breaker.js';
import { ModelRouter } from '../router/index.js';
import type { WorkRequest } from '../work/index.js';
import type { Workspace } from './ports.js';
import { issueBodyHash, type PlanReuseRecord, type PlanReuseStore } from './resume-context.js';
import { WORKER_MODELS, WORKER_ROUTES, workerPolicy as policy } from '../test-support/worker-policy.test.js';
import { runIssue, type RunPorts, type RunRequest } from './run-issue.js';

const WORK: WorkRequest = {
  id: 'github-issue:o/r#1',
  kind: 'github-issue',
  title: 'Fix the thing',
  brief: 'do the thing',
  acceptanceCriteria: [],
};

const dirs = createTempDirs();
const breakerDir = dirs.makeSync('run-issue-design-checkpoint-');
afterAll(() => dirs.cleanup());

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

const PLAN_OK: PlanResult = {
  ok: true,
  route: 'claude',
  specPath: '/tmp/wt/spec.md',
  model: 'm',
  designArtifact: null,
};

function octokitWith(labels: unknown[] | Error) {
  const posted: unknown[] = [];
  const labelReads: unknown[] = [];
  const createComment = async (arg: unknown) => {
    posted.push(arg);
    return { data: { id: 1 } };
  };
  const get = async (arg: unknown) => {
    labelReads.push(arg);
    if (labels instanceof Error) throw labels;
    return { data: { labels } };
  };
  const octokit = Object.assign({} as Octokit, {
    rest: {
      users: { getAuthenticated: vi.fn(async () => ({ data: { login: 'bot' } })) },
      issues: {
        get,
        createComment,
        listComments: vi.fn(async () => ({ data: [] })),
        updateComment: vi.fn(async () => ({ data: {} })),
        addLabels: vi.fn(async () => ({ data: [] })),
        removeLabel: vi.fn(async () => ({ data: [] })),
      },
    },
  });
  return { octokit, posted, labelReads };
}

function storeWith(load: PlanResult | null) {
  const recorded: PlanReuseRecord[] = [];
  const store: PlanReuseStore = {
    load: async () => load,
    record: async (entry) => {
      recorded.push(entry);
    },
    clear: async () => {},
  };
  return { store, recorded };
}

function setup(labels: unknown[] | Error, planReuse?: PlanReuseStore) {
  const events: Array<[string, string]> = [];
  const planOpts: Parameters<typeof realPlanPhase>[0][] = [];
  const buildOpts: Parameters<typeof realBuildPhase>[0][] = [];
  const o = octokitWith(labels);
  const ports: RunPorts = {
    router: new ModelRouter(WORKER_MODELS, WORKER_ROUTES),
    octokit: o.octokit,
    workspace: { path: '/tmp/wt', dispose: async () => {} } as Workspace,
    events: () => (t: string, m: string) => events.push([t, m]),
    breaker: new ProviderBreaker(join(breakerDir, 'breaker.json')),
    resolveConstitution: () => null,
    planPhase: async (opts) => (planOpts.push(opts), PLAN_OK),
    buildPhase: async (opts) => (buildOpts.push(opts), { ok: false } as never),
    checkPhase: vi.fn<typeof realCheckPhase>(),
    shipPhase: vi.fn<typeof realShipPhase>(),
    planReuse,
    readWorktreeHead: async () => 'abc123',
  };
  return { ports, planOpts, buildOpts, events, ...o };
}

describe('runIssue — design checkpoint (#3621)', () => {
  it('parks held after a successful PLAN when the issue is labeled factory:needs-design and never calls buildPhase', async () => {
    const { store, recorded } = storeWith(null);
    const s = setup([{ name: 'factory:needs-design' }], store);
    const outcome = await runIssue(request, policy, s.ports);
    expect(outcome).toMatchObject({ state: 'parked', reason: 'held' });
    expect(s.buildOpts).toEqual([]);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ bodyHash: issueBodyHash(WORK.brief), route: 'claude' });
    const bodies = s.posted.map((c) => JSON.stringify(c));
    expect(bodies.some((b) => b.includes('factory:needs-design') && b.includes('/tmp/wt/spec.md'))).toBe(true);
  });

  it('after the label is removed the next claim reuses the frozen plan and builds on the same specPath and branch', async () => {
    const { store, recorded } = storeWith(PLAN_OK);
    const s = setup([], store);
    await runIssue(request, policy, s.ports);
    expect(s.planOpts).toEqual([]);
    expect(s.buildOpts).toHaveLength(1);
    expect(s.buildOpts[0]).toMatchObject({ specPath: request.specPath, branch: request.branch });
    expect(recorded).toEqual([]);
  });

  it('an unlabeled issue goes from PLAN straight to BUILD with no park', async () => {
    const { store, recorded } = storeWith(null);
    const s = setup([{ name: 'bug' }], store);
    const outcome = await runIssue(request, policy, s.ports);
    expect(s.buildOpts).toHaveLength(1);
    expect(outcome).not.toMatchObject({ reason: 'held' });
    expect(recorded).toEqual([]);
  });

  it('a labeled issue under localOnly builds without reading labels', async () => {
    const s = setup([{ name: 'factory:needs-design' }]);
    await runIssue({ ...request, localOnly: true }, policy, s.ports);
    expect(s.labelReads).toEqual([]);
    expect(s.buildOpts).toHaveLength(1);
  });

  it('an issues.get throw logs environment_warning and builds', async () => {
    const s = setup(new Error('rate limited'));
    await runIssue(request, policy, s.ports);
    expect(s.events.some(([t, m]) => t === 'environment_warning' && m.includes('rate limited'))).toBe(true);
    expect(s.buildOpts).toHaveLength(1);
  });
});
