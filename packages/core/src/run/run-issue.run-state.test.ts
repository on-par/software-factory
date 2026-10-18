// run-issue.run-state.test.ts — runIssue persists its run state through ports.recordRunState (#3194)
import { join } from 'node:path';

import type { Octokit } from '@octokit/rest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { createTempDirs } from '../harness/temp-dir.js';
import type { BuildResult, buildPhase as realBuildPhase } from '../phases/build.js';
import type { CheckPhaseResult, checkPhase as realCheckPhase } from '../phases/check.js';
import type { PlanResult, planPhase as realPlanPhase } from '../phases/plan.js';
import type { ShipResult, shipPhase as realShipPhase } from '../phases/ship.js';
import { ProviderBreaker } from '../router/breaker.js';
import { ModelRouter } from '../router/index.js';
import type { CheckSummary } from '../types/index.js';
import type { WorkRequest } from '../work/index.js';
import type { RunPolicy } from './policy.js';
import type { Workspace } from './ports.js';
import { runIssue, type RunPorts, type RunRequest } from './run-issue.js';

const PLAN_OK: PlanResult = { ok: true, route: 'codex', specPath: '/tmp/wt/spec.md', model: 'm', designArtifact: null };
const BUILD_OK: BuildResult = { ok: true, model: 'm', route: 'codex' };
const CHECK_SUMMARY: CheckSummary = { failures: 0, passes: 1, skips: 0, total: 1, results: [] };
const CHECK_OK: CheckPhaseResult = { passed: true, summary: CHECK_SUMMARY, reworkRounds: 0 };
const SHIP_OK: ShipResult = { ok: true, prNumber: 42 };

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
  failover: { triggers: [], maxRetries: 0, cooldownMs: 0, escalateAfterTierExhausted: false },
  routingRules: {},
};

const tempDirs = createTempDirs();
const breakerDir = tempDirs.makeSync('run-issue-run-state-');
afterAll(() => tempDirs.cleanup());

const planPhase = vi.fn<typeof realPlanPhase>();
const buildPhase = vi.fn<typeof realBuildPhase>();
const checkPhase = vi.fn<typeof realCheckPhase>();
const shipPhase = vi.fn<typeof realShipPhase>();

function baseRequest(): RunRequest {
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
  };
}

function basePolicy(): RunPolicy {
  return {
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
}

let breakerFileCounter = 0;

function basePorts(overrides: Partial<RunPorts> = {}): RunPorts {
  return {
    router: new ModelRouter(MODELS, ROUTES),
    octokit: {} as Octokit,
    workspace: { path: '/tmp/wt', dispose: async () => {} } as Workspace,
    events: () => () => {},
    breaker: new ProviderBreaker(join(breakerDir, `breaker-${breakerFileCounter++}.json`)),
    resolveConstitution: () => null,
    planPhase,
    buildPhase,
    checkPhase,
    shipPhase,
    ...overrides,
  };
}

beforeEach(() => {
  planPhase.mockReset().mockResolvedValue(PLAN_OK);
  buildPhase.mockReset().mockResolvedValue(BUILD_OK);
  checkPhase.mockReset().mockResolvedValue(CHECK_OK);
  shipPhase.mockReset().mockResolvedValue(SHIP_OK);
});

describe('runIssue — #3194: persisted run state', () => {
  it('calls recordRunState with planning, building, checking, shipping, then ready with the PR number', async () => {
    const recordRunState = vi.fn().mockResolvedValue(undefined);
    const outcome = await runIssue(baseRequest(), basePolicy(), basePorts({ recordRunState }));
    expect(outcome.state).toBe('ready');
    const updates = recordRunState.mock.calls.map((call) => call[0]);
    expect(updates.map((u) => u.status)).toEqual(['planning', 'building', 'checking', 'shipping', 'ready']);
    expect(updates.at(-1)).toMatchObject({ prNumber: (outcome as { prNumber?: number }).prNumber });
    for (const u of updates.slice(1)) expect(u.branch).toBe(baseRequest().branch);
  });

  it('records parked with the failing checker outputs when CHECK parks', async () => {
    checkPhase.mockResolvedValue({
      passed: false,
      summary: { ...CHECK_SUMMARY, results: [{ checker: 'tests', result: 'FAIL', details: 'nope' }] },
      reworkRounds: 1,
      failureSignature: 'sig-1',
    });
    const recordRunState = vi.fn().mockResolvedValue(undefined);
    await runIssue(baseRequest(), basePolicy(), basePorts({ recordRunState }));
    const last = recordRunState.mock.calls.at(-1)?.[0];
    expect(last.status).toBe('parked');
    expect(last.failures).toEqual([{ checker: 'tests', result: 'FAIL', details: 'nope' }]);
  });

  it('logs run_state_failed but does not change the outcome when recordRunState rejects', async () => {
    const baseline = await runIssue(baseRequest(), basePolicy(), basePorts());
    const events: Array<[string, string]> = [];
    const log = vi.fn((type: string, message: string) => events.push([type, message]));
    const recordRunState = vi.fn().mockRejectedValue(new Error('disk full'));
    const outcome = await runIssue(baseRequest(), basePolicy(), basePorts({ recordRunState, events: () => log }));
    expect(outcome).toEqual(baseline);
    const failures = events.filter(([type]) => type === 'run_state_failed');
    expect(failures).toHaveLength(5);
    expect(failures[0][1]).toContain('disk full');
  });

  it('records escalated and rethrows when the decompose hook throws', async () => {
    planPhase.mockResolvedValue({ ...PLAN_OK, ok: false, decomposed: { childIssues: [2] } });
    const onDecomposed = vi.fn(() => {
      throw Object.assign(new Error('decomposed'), { childIssues: [2] });
    });
    const recordRunState = vi.fn().mockResolvedValue(undefined);
    await expect(runIssue(baseRequest(), basePolicy(), basePorts({ onDecomposed, recordRunState }))).rejects.toThrow(
      'decomposed',
    );
    expect(recordRunState.mock.calls.at(-1)?.[0].status).toBe('escalated');
  });
});
