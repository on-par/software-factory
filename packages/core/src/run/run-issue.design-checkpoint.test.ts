import { join } from 'node:path';

import { createTempDirs } from '@on-par/factory-core/testing';
import type { Octokit } from '@octokit/rest';
import { afterAll, describe, expect, it, vi } from 'vitest';

import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import type { buildPhase as realBuildPhase } from '../phases/build.js';
import type { checkPhase as realCheckPhase } from '../phases/check.js';
import type { PlanResult, planPhase as realPlanPhase } from '../phases/plan.js';
import type { shipPhase as realShipPhase } from '../phases/ship.js';
import { ProviderBreaker } from '../router/breaker.js';
import { ModelRouter } from '../router/index.js';
import type { WorkRequest } from '../work/index.js';
import type { RunPolicy } from './policy.js';
import type { Workspace } from './ports.js';
import { issueBodyHash, type PlanReuseStore } from './resume-context.js';
import { runIssue, type RunPorts, type RunRequest } from './run-issue.js';
import { policy as baseline } from './ci-rework-test-helpers.js';

const WORK: WorkRequest = {
  id: 'github-issue:o/r#1',
  kind: 'github-issue',
  title: 'Fix the thing',
  brief: 'do the thing',
  acceptanceCriteria: [],
};

const ROUTES: RoutesConfig = {
  version: 1,
  routes: {
    build_claude: { tier: 'worker', description: 'stub', requires: 'claude' },
    build_codex: { tier: 'worker', description: 'stub', requires: 'codex' },
    build_command: { tier: 'worker', description: 'stub', requires: 'command' },
  },
};

const MODELS: ModelsConfig = {
  version: 1,
  models: {
    'my-model': {
      provider: 'custom',
      tier: 'worker',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
      harness: 'my-agent',
    },
  },
  tiers: { worker: ['my-model'] },
  failover: { triggers: [], maxRetries: 0, cooldownMs: 0 },
  routingRules: {},
  harnesses: {
    'my-agent': { command: 'my-agent {model}', prompt: 'stdin', output: 'stdout', agentic: true, usage: 'none' },
  },
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

const policy: RunPolicy = { ...baseline, models: MODELS, routes: ROUTES };

const PLAN_OK: PlanResult = {
  ok: true,
  route: 'claude',
  specPath: '/tmp/wt/spec.md',
  model: 'm',
  designArtifact: null,
};

const recording =
  <A, R>(into: A[], result: R) =>
  async (arg: A) => (into.push(arg), result);

function octokitWith(labels: unknown[] | Error) {
  const comments: string[] = [];
  const labelReads: number[] = [];
  const createComment = async (p: unknown) => ({ data: { id: comments.push(JSON.stringify(p)) } });
  const get = async () => {
    labelReads.push(1);
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
  return { octokit, labelReads, comments };
}

function storeWith(load: PlanResult | null) {
  const recorded: Parameters<PlanReuseStore['record']>[0][] = [];
  const store: PlanReuseStore = {
    load: vi.fn<PlanReuseStore['load']>(async () => load),
    record: async (r) => void recorded.push(r),
    clear: vi.fn<PlanReuseStore['clear']>(async () => {}),
  };
  return { store, recorded };
}

function setup(labels: unknown[] | Error, planReuse?: PlanReuseStore) {
  const plans: Parameters<typeof realPlanPhase>[0][] = [];
  const builds: Parameters<typeof realBuildPhase>[0][] = [];
  const planPhase = vi.fn<typeof realPlanPhase>(recording(plans, PLAN_OK));
  const buildPhase = vi.fn<typeof realBuildPhase>(recording(builds, { ok: false } as never));
  const events: Array<[string, string]> = [];
  const o = octokitWith(labels);
  const ports: RunPorts = {
    router: new ModelRouter(MODELS, ROUTES),
    octokit: o.octokit,
    workspace: { path: '/tmp/wt', dispose: async () => {} } as Workspace,
    events: () => (t: string, m: string) => events.push([t, m]),
    breaker: new ProviderBreaker(join(breakerDir, 'breaker.json')),
    resolveConstitution: () => null,
    planPhase,
    buildPhase,
    checkPhase: vi.fn<typeof realCheckPhase>(),
    shipPhase: vi.fn<typeof realShipPhase>(),
    planReuse,
    readWorktreeHead: async () => 'abc123',
  };
  return { ports, plans, builds, events, ...o };
}

describe('runIssue — design checkpoint (#3621)', () => {
  it('parks held after a successful PLAN when the issue is labeled factory:needs-design and never calls buildPhase', async () => {
    const { store, recorded } = storeWith(null);
    const s = setup([{ name: 'factory:needs-design' }], store);
    const outcome = await runIssue(request, policy, s.ports);
    expect(outcome).toMatchObject({ state: 'parked', reason: 'held' });
    expect(s.builds).toEqual([]);
    expect(recorded).toEqual([expect.objectContaining({ bodyHash: issueBodyHash(WORK.brief), route: 'claude' })]);
    expect(s.comments.some((b) => b.includes('factory:needs-design') && b.includes('/tmp/wt/spec.md'))).toBe(true);
  });

  it('after the label is removed the next claim reuses the frozen plan and builds on the same specPath and branch', async () => {
    const { store, recorded } = storeWith(PLAN_OK);
    const s = setup([], store);
    await runIssue(request, policy, s.ports);
    expect(s.plans).toEqual([]);
    expect(s.builds).toEqual([expect.objectContaining({ specPath: request.specPath, branch: request.branch })]);
    expect(recorded).toEqual([]);
  });

  it('an unlabeled issue goes from PLAN straight to BUILD with no park', async () => {
    const { store, recorded } = storeWith(null);
    const s = setup([{ name: 'bug' }], store);
    const outcome = await runIssue(request, policy, s.ports);
    expect(s.builds).toHaveLength(1);
    expect(outcome).not.toMatchObject({ reason: 'held' });
    expect(recorded).toEqual([]);
  });

  it('a labeled issue under localOnly builds without reading labels', async () => {
    const s = setup([{ name: 'factory:needs-design' }]);
    await runIssue({ ...request, localOnly: true }, policy, s.ports);
    expect(s.labelReads).toEqual([]);
    expect(s.builds).toHaveLength(1);
  });

  it('an issues.get throw logs environment_warning and builds', async () => {
    const s = setup(new Error('rate limited'));
    await runIssue(request, policy, s.ports);
    expect(s.events.some(([t, m]) => t === 'environment_warning' && m.includes('rate limited'))).toBe(true);
    expect(s.builds).toHaveLength(1);
  });
});
