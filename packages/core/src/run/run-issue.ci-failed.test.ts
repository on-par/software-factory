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
import { ProviderBreaker } from '../router/breaker.js';
import { ModelRouter } from '../router/index.js';
import type { CiFailureEvidence } from '../types/index.js';
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

const breakerDir = mkdtempSync(join(tmpdir(), 'run-issue-ci-failed-'));
afterAll(() => rmSync(breakerDir, { recursive: true, force: true }));

type Log = ReturnType<RunPorts['events']>;

function ports(log: Log): RunPorts {
  return {
    router: new ModelRouter(MODELS, ROUTES),
    octokit: {} as Octokit,
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
  vi.mocked(planPhase).mockReset().mockResolvedValue(PLAN_OK);
  vi.mocked(buildPhase).mockReset().mockResolvedValue(BUILD_OK);
  vi.mocked(checkPhase).mockReset().mockResolvedValue(CHECK_OK);
});

describe('runIssue — SHIP CI failure parks as ci-failed (#2814)', () => {
  const EVIDENCE: CiFailureEvidence = {
    failingChecks: [{ name: 'CodeQL', conclusion: 'failure', summary: '1 new alert' }],
    alerts: [{ ruleId: 'js/request-forgery', location: 'packages/core/src/sandbox/egress-proxy.ts:130', message: 'm' }],
    truncated: false,
  };

  it('parks a ship CI failure as ci-failed with the evidence on the park event', async () => {
    shipPhase.mockResolvedValue({
      ok: false,
      prNumber: 9,
      reason: 'CI failed for PR #9',
      ciOutcome: 'failure',
      ciFailure: EVIDENCE,
    });
    const log = vi.fn<Log>();
    const outcome = await runIssue(request, policy, ports(log));
    expect(outcome).toMatchObject({ state: 'parked', reason: 'ci-failed' });
    expect(log).toHaveBeenCalledWith(
      'ci-failed',
      'ship phase failed: CI failed for PR #9',
      expect.objectContaining({ ciFailure: EVIDENCE }),
    );
    expect(log.mock.calls.some(([type]) => type === 'fail')).toBe(false);
  });

  it('still parks a non-CI ship failure as fail', async () => {
    shipPhase.mockResolvedValue({ ok: false, reason: 'push failed' });
    const log = vi.fn<Log>();
    const outcome = await runIssue(request, policy, ports(log));
    expect(outcome).toMatchObject({ state: 'parked', reason: 'fail' });
    expect(log).toHaveBeenCalledWith(
      'fail',
      'ship phase failed: push failed',
      expect.objectContaining({ attribution: expect.anything() }),
    );
  });

  it('keeps ci-infra and escalate parks unchanged', async () => {
    shipPhase.mockResolvedValue({ ok: false, reason: 'infra', ciOutcome: 'infra-failure' });
    expect(await runIssue(request, policy, ports(vi.fn<Log>()))).toMatchObject({ reason: 'ci-infra' });
    shipPhase.mockResolvedValue({ ok: false, denied: true, deniedReason: 'no' });
    expect(await runIssue(request, policy, ports(vi.fn<Log>()))).toMatchObject({ reason: 'escalate' });
  });
});
