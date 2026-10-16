import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Octokit } from '@octokit/rest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import type { BuildResult, buildPhase as realBuildPhase } from '../phases/build.js';
import type { CheckPhaseResult, checkPhase as realCheckPhase } from '../phases/check.js';
import type { PlanResult, planPhase as realPlanPhase } from '../phases/plan.js';
import type { shipPhase as realShipPhase } from '../phases/ship.js';
import {
  overCapReason,
  parseSlicePlanComment,
  renderSlicePlanComment,
  stackSliceBranch,
  withSliceBranchCreated,
  type SlicePlan,
} from '../readiness/slice-plan.js';
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
  routes: {
    build_claude: { tier: 'worker', description: 'stub', requires: 'claude' },
    build_codex: { tier: 'worker', description: 'stub', requires: 'codex' },
  },
};

const MODELS: ModelsConfig = {
  version: 1,
  models: {},
  tiers: {},
  failover: { triggers: [], maxRetries: 0, cooldownMs: 0, escalateAfterTierExhausted: false },
  routingRules: {},
};

const breakerDir = mkdtempSync(join(tmpdir(), 'run-issue-stack-'));
afterAll(() => rmSync(breakerDir, { recursive: true, force: true }));
let breakerCounter = 0;

function baseRequest(overrides: Partial<RunRequest> = {}): RunRequest {
  return {
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
    sizeGateMode: 'stack',
    ...overrides,
  };
}

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

const story = (n: number) => ({
  schemaVersion: 1 as const,
  kind: 'story' as const,
  filesLikelyTouched: [],
  labels: [],
  title: `Story ${n}`,
  role: 'operator',
  want: `thing ${n} works`,
  soThat: 'value',
  problemStatement: `Problem ${n}`,
  inScope: [`Scope ${n}`],
  outOfScope: ['Persistent storage'],
  acceptanceCriteria: [{ name: `ac ${n}`, given: [], when: ['run'], then: ['works'] }],
  verification: [{ command: 'npm test', passWhen: 'passes' }],
  tracesTo: ['INT-PROBLEM-01'],
});
const freshPlan = (): SlicePlan => ({
  issue: 1,
  slices: [1, 2, 3].map((n) => ({ index: n, title: `S${n}`, story: story(n) as never, state: 'pending' as const })),
});
const branch = (k: number) => stackSliceBranch(1, k);

function stackSetup(opts: { recordBranches?: boolean } = {}) {
  const recordBranches = opts.recordBranches ?? true;
  planPhase.mockImplementation(async (o) => {
    const index = o.sliceIndex ?? 1;
    let plan = freshPlan();
    if (recordBranches) for (let i = 1; i < index; i++) plan = withSliceBranchCreated(plan, i, branch(i));
    return { ...PLAN_OK, slice: { plan, index } };
  });
  let pr = 100;
  shipPhase.mockImplementation(async () => ({ ok: true, prNumber: ++pr }));
  const bodies: string[] = [];
  const record = vi.fn(async (a: { body: string }) => {
    bodies.push(a.body);
    return { data: {} };
  });
  const octokit: Octokit = {
    rest: {
      users: { getAuthenticated: async () => ({ data: { id: 7 } }) },
      issues: {
        listComments: async () => ({ data: [{ id: 99, user: { id: 7 }, body: renderSlicePlanComment(freshPlan()) }] }),
        createComment: record,
        updateComment: record,
      },
    },
  } as never;
  const createSliceBranch = vi.fn(async (_o: { worktree: string; branch: string; startPoint: string }) => {});
  breakerCounter += 1;
  const ports: RunPorts = {
    router: new ModelRouter(MODELS, ROUTES),
    octokit,
    workspace: { path: '/tmp/wt', dispose: async () => {} } as Workspace,
    events: () => vi.fn(),
    breaker: new ProviderBreaker(join(breakerDir, `breaker-${breakerCounter}.json`)),
    resolveConstitution: () => null,
    planPhase,
    buildPhase,
    checkPhase,
    shipPhase,
    createSliceBranch,
  };
  return { ports, createSliceBranch, record, bodies };
}

beforeEach(() => {
  planPhase.mockReset();
  buildPhase.mockReset().mockResolvedValue(BUILD_OK);
  checkPhase.mockReset().mockResolvedValue(CHECK_OK);
  shipPhase.mockReset();
});

describe('runIssue — stack mode chains slice branches (ADR-0161)', () => {
  it('builds three slices in one call, branching each from its parent', async () => {
    const { ports, createSliceBranch } = stackSetup();
    const outcome = await runIssue(baseRequest(), policy, ports);

    expect(planPhase.mock.calls.map((c) => c[0].sliceIndex)).toEqual([undefined, 2, 3]);
    expect(createSliceBranch.mock.calls.map((c) => [c[0].branch, c[0].startPoint])).toEqual([
      [branch(1), 'origin/main'],
      [branch(2), branch(1)],
      [branch(3), branch(2)],
    ]);
    expect(buildPhase.mock.calls.map((c) => c[0].branch)).toEqual([branch(1), branch(2), branch(3)]);
    expect(outcome).toMatchObject({ state: 'ready', slice: { index: 3, count: 3 } });
  });

  it('builds at most maxSlices slices when the gate is bypassed', async () => {
    const { ports, createSliceBranch } = stackSetup();
    const outcome = await runIssue(baseRequest({ maxSlices: 2 }), policy, ports);

    expect(planPhase.mock.calls.map((c) => c[0].sliceIndex)).toEqual([undefined, 2]);
    expect(buildPhase.mock.calls.map((c) => c[0].branch)).toEqual([branch(1), branch(2)]);
    expect(createSliceBranch).toHaveBeenCalledTimes(2);
    expect(outcome).toMatchObject({ state: 'ready', slice: { index: 2, count: 3 } });
  });

  it('parks over-cap through the gate and builds no slice', async () => {
    const { ports } = stackSetup();
    planPhase.mockImplementation(async () => ({
      ok: false,
      route: 'codex',
      specPath: '/tmp/wt/spec.md',
      model: '',
      escalate: overCapReason(3, 2),
      designArtifact: null,
    }));
    const outcome = await runIssue(baseRequest({ maxSlices: 2 }), policy, ports);

    expect(outcome.state).toBe('escalated');
    expect(planPhase).toHaveBeenCalledTimes(1);
    expect(buildPhase).not.toHaveBeenCalled();
  });

  it('passes the parent slice branch to checkPhase as parentBaseRef', async () => {
    const { ports } = stackSetup();
    await runIssue(baseRequest(), policy, ports);

    expect(checkPhase.mock.calls.map((c) => c[0].parentBaseRef)).toEqual([undefined, branch(1), branch(2)]);
    expect(buildPhase.mock.calls.map((c) => c[0].parentBaseRef)).toEqual([undefined, branch(1), branch(2)]);
  });

  it('records each slice branch in the plan comment before BUILD', async () => {
    const { ports, record, bodies } = stackSetup();
    await runIssue(baseRequest(), policy, ports);

    for (const k of [1, 2, 3]) {
      const writeIdx = bodies.findIndex((b) => {
        const parsed = parseSlicePlanComment(b);
        return parsed?.ok === true && parsed.plan.slices[k - 1]?.branch === branch(k);
      });
      expect(writeIdx).toBeGreaterThanOrEqual(0);
      expect(record.mock.invocationCallOrder[writeIdx]).toBeLessThan(buildPhase.mock.invocationCallOrder[k - 1]);
    }
  });

  it('stops the chain at the first non-ready slice', async () => {
    const { ports } = stackSetup();
    checkPhase
      .mockReset()
      .mockResolvedValueOnce(CHECK_OK)
      .mockResolvedValue({ passed: false, summary: { ...CHECK_SUMMARY, failures: 1 }, reworkRounds: 0 });
    const outcome = await runIssue(baseRequest(), policy, ports);

    expect(planPhase).toHaveBeenCalledTimes(2);
    expect(outcome.state).not.toBe('ready');
  });

  it('parks fail when the parent slice branch is not recorded', async () => {
    const { ports, createSliceBranch } = stackSetup();
    planPhase.mockImplementation(async () => ({ ...PLAN_OK, slice: { plan: freshPlan(), index: 2 } }));
    const outcome = await runIssue(baseRequest(), policy, ports);

    expect(outcome).toMatchObject({ state: 'parked', reason: 'fail' });
    expect(createSliceBranch).not.toHaveBeenCalled();
    expect(buildPhase).not.toHaveBeenCalled();
  });

  it('parks fail when the slice branch cannot be created', async () => {
    const { ports, createSliceBranch } = stackSetup();
    createSliceBranch.mockRejectedValue(new Error('bad ref'));
    const outcome = await runIssue(baseRequest(), policy, ports);

    expect(outcome).toMatchObject({ state: 'parked', reason: 'fail' });
    expect(buildPhase).not.toHaveBeenCalled();
  });

  it('parks fail when recording the branch in the plan comment fails', async () => {
    const { ports, record } = stackSetup();
    record.mockRejectedValue(new Error('boom'));
    const outcome = await runIssue(baseRequest(), policy, ports);

    expect(outcome).toMatchObject({ state: 'parked', reason: 'fail' });
    expect(buildPhase).not.toHaveBeenCalled();
  });

  it.each(['slice', 'file', 'off'] as const)('%s mode makes a single pass and creates no branch', async (mode) => {
    const { ports, createSliceBranch } = stackSetup();
    await runIssue(baseRequest({ sizeGateMode: mode }), policy, ports);

    expect(planPhase).toHaveBeenCalledTimes(1);
    expect(createSliceBranch).not.toHaveBeenCalled();
  });
});
