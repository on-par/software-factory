import { join } from 'node:path';

import type { Octokit } from '@octokit/rest';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import type { BuildResult, buildPhase as realBuildPhase } from '../phases/build.js';
import type { CheckPhaseResult, checkPhase as realCheckPhase } from '../phases/check.js';
import type { PlanResult, planPhase as realPlanPhase } from '../phases/plan.js';
import type { ShipResult, shipPhase as realShipPhase } from '../phases/ship.js';
import { ProviderBreaker } from '../router/breaker.js';
import { createTempDirs } from '../harness/temp-dir.js';
import { ModelRouter } from '../router/index.js';
import type { CiFailureEvidence } from '../types/index.js';
import { ReworkHistory } from '../checkers/rework-history.js';
import type { WorkRequest } from '../work/index.js';
import type { RunPolicy } from './policy.js';
import type { Workspace } from './ports.js';
import type { reworkWorker as realReworkWorker } from '../phases/check.js';
import { CI_REWORK_INSTRUCTIONS } from './ci-rework.js';
import { runIssue, type RunPorts, type RunRequest } from './run-issue.js';

const planPhase = vi.fn<typeof realPlanPhase>();
const buildPhase = vi.fn<typeof realBuildPhase>();
const checkPhase = vi.fn<typeof realCheckPhase>();
const shipPhase = vi.fn<typeof realShipPhase>();
const reworkWorker = vi.fn<typeof realReworkWorker>();
const readWorktreeHead = vi.fn<(worktree: string) => Promise<string>>();
const readReworkDiff = vi.fn<(worktree: string, fromSha: string) => Promise<string>>();
const mergeBaseIntoWorktree = vi.fn<NonNullable<RunPorts['mergeBaseIntoWorktree']>>();
const collectFailingJobLogs = vi.fn<NonNullable<RunPorts['collectFailingJobLogs']>>();
const listPrChangedFiles = vi.fn<(...args: unknown[]) => Promise<string[]>>();
const listBaseFailingChecks =
  vi.fn<(...args: unknown[]) => Promise<{ baseRef: string; baseSha: string; failing: string[] }>>();
const listBaseCodeqlAlerts =
  vi.fn<(...args: unknown[]) => Promise<{ baseRef: string; numbers: number[]; refs: string[] }>>();

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

const tmp = createTempDirs();
const breakerDir = tmp.makeSync('run-issue-ci-rework-');
afterAll(() => tmp.cleanup());

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
    reworkWorker,
    readWorktreeHead,
    readReworkDiff,
    listPrChangedFiles: listPrChangedFiles as RunPorts['listPrChangedFiles'],
    listBaseFailingChecks: listBaseFailingChecks as RunPorts['listBaseFailingChecks'],
    listBaseCodeqlAlerts: listBaseCodeqlAlerts as RunPorts['listBaseCodeqlAlerts'],
    mergeBaseIntoWorktree,
    collectFailingJobLogs,
  };
}

beforeEach(() => {
  vi.mocked(planPhase).mockReset().mockResolvedValue(PLAN_OK);
  vi.mocked(buildPhase).mockReset().mockResolvedValue(BUILD_OK);
  vi.mocked(checkPhase).mockReset().mockResolvedValue(CHECK_OK);
  shipPhase.mockReset();
  reworkWorker.mockReset().mockResolvedValue({ failovers: [], modelCompleted: true });
  readWorktreeHead.mockReset().mockResolvedValue('a'.repeat(40));
  readReworkDiff.mockReset().mockResolvedValue('');
  listPrChangedFiles.mockReset().mockResolvedValue(['packages/core/src/sandbox/egress-proxy.ts']);
  listBaseFailingChecks.mockReset().mockResolvedValue({ baseRef: 'main', baseSha: 'b'.repeat(40), failing: [] });
  listBaseCodeqlAlerts.mockReset().mockResolvedValue({ baseRef: 'main', numbers: [], refs: [] });
  mergeBaseIntoWorktree.mockReset().mockResolvedValue({ ok: true, merged: true });
  collectFailingJobLogs.mockReset().mockResolvedValue({
    jobLogs: [
      { name: 'test (2/3)', jobId: 7, excerpt: 'FAIL scripts/x.test.ts expected 1 to be 78', truncated: false },
    ],
    errors: [],
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('shipWithCiRework — re-CHECK parity with the first CHECK (#3435)', () => {
  const EVIDENCE: CiFailureEvidence = {
    failingChecks: [{ name: 'CodeQL', conclusion: 'failure', summary: '1 new alert' }],
    alerts: [{ ruleId: 'js/request-forgery', location: 'packages/core/src/sandbox/egress-proxy.ts:130', message: 'x' }],
    truncated: false,
  };
  const CI_FAIL = {
    ok: false,
    prNumber: 9,
    reason: 'CI failed for PR #9',
    ciOutcome: 'failure',
    ciFailure: EVIDENCE,
    headSha: 'sha',
  } as const;
  const failing = (over: Partial<CheckPhaseResult> = {}): CheckPhaseResult => ({
    ...CHECK_OK,
    passed: false,
    summary: {
      failures: 1,
      passes: 0,
      skips: 0,
      total: 1,
      results: [{ checker: 'tests', result: 'FAIL', details: 'boom' }],
    },
    ...over,
  });

  beforeEach(() => {
    shipPhase.mockResolvedValue(CI_FAIL);
  });

  it('a cross-run-stuck re-CHECK parks held', async () => {
    vi.mocked(checkPhase)
      .mockResolvedValueOnce(CHECK_OK)
      .mockResolvedValueOnce(failing({ stuck: true, crossRunStuck: true }));
    expect(await runIssue(request, policy, ports(vi.fn<Log>()))).toMatchObject({ state: 'parked', reason: 'held' });
    expect(shipPhase).toHaveBeenCalledTimes(1);
  });

  it('a stuck re-CHECK parks escalate', async () => {
    vi.mocked(checkPhase)
      .mockResolvedValueOnce(CHECK_OK)
      .mockResolvedValueOnce(failing({ stuck: true }));
    expect(await runIssue(request, policy, ports(vi.fn<Log>()))).toMatchObject({ state: 'parked', reason: 'escalate' });
  });

  it('an environment re-CHECK releases the issue', async () => {
    const environment: NonNullable<CheckPhaseResult['environment']> = {
      cause: 'environment',
      baseSha: 'b'.repeat(40),
      failingChecks: ['tests'],
      logPaths: [],
    };
    vi.mocked(checkPhase).mockResolvedValueOnce(CHECK_OK).mockResolvedValueOnce(failing({ environment }));
    const outcome = await runIssue(request, policy, ports(vi.fn<Log>()));
    expect(outcome).toMatchObject({ state: 'released', reason: 'environment' });
    expect(outcome).not.toHaveProperty('buildPreserved');
  });

  it('a config-cause re-CHECK parks config', async () => {
    const environment: NonNullable<CheckPhaseResult['environment']> = {
      cause: 'config',
      baseSha: 'b'.repeat(40),
      failingChecks: ['tests'],
      logPaths: [],
    };
    vi.mocked(checkPhase).mockResolvedValueOnce(CHECK_OK).mockResolvedValueOnce(failing({ environment }));
    expect(await runIssue(request, policy, ports(vi.fn<Log>()))).toMatchObject({ state: 'parked', reason: 'config' });
  });

  it('a failing re-CHECK records rework history and run-state failures', async () => {
    vi.mocked(checkPhase)
      .mockResolvedValueOnce(CHECK_OK)
      .mockResolvedValueOnce(failing({ failureSignature: 'sig' }));
    const history = new ReworkHistory(join(breakerDir, 'history.json'));
    const record = vi.spyOn(history, 'record');
    const recordRunState = vi.fn();
    const outcome = await runIssue(request, policy, {
      ...ports(vi.fn<Log>()),
      reworkHistory: history,
      recordRunState,
    });
    expect(outcome).toMatchObject({ state: 'parked', reason: 'fail' });
    expect(record).toHaveBeenCalledWith(1, 'sig', ['tests']);
    const last = recordRunState.mock.calls.at(-1)?.[0];
    expect(last.failures.length).toBeGreaterThan(0);
  });

  it('a passing re-CHECK over the budget parks fail before SHIP re-entry', async () => {
    let spend = 0;
    vi.mocked(checkPhase)
      .mockResolvedValueOnce(CHECK_OK)
      .mockImplementationOnce(async () => {
        spend = 100;
        return CHECK_OK;
      });
    const outcome = await runIssue(
      { ...request },
      { ...policy, budget: { perIssueCapUsd: 5 } },
      { ...ports(vi.fn<Log>()), getIssueSpend: () => spend },
    );
    expect(outcome).toMatchObject({ state: 'parked', reason: 'fail' });
    expect(shipPhase).toHaveBeenCalledTimes(1);
  });
});

describe('shipWithCiRework — attributable non-CodeQL checks (#3537)', () => {
  const TEST_FAIL: ShipResult = {
    ok: false,
    prNumber: 9,
    reason: 'CI failed for PR #9',
    ciOutcome: 'failure',
    ciFailure: {
      failingChecks: [{ name: 'test (2/3)', conclusion: 'failure' }],
      alerts: [],
      truncated: false,
    },
    headSha: 'sha',
  };
  const SUCCESS: ShipResult = { ok: true, prNumber: 9, ciOutcome: 'success' };

  it('an attributable non-CodeQL failing check gets a CI rework round', async () => {
    shipPhase.mockResolvedValueOnce(TEST_FAIL).mockResolvedValueOnce(SUCCESS);
    const log = vi.fn<Log>();
    const outcome = await runIssue(request, policy, ports(log));
    expect(outcome).toMatchObject({ state: 'ready' });
    expect(reworkWorker).toHaveBeenCalledTimes(1);
    const details = reworkWorker.mock.calls[0][0].summary.results[0].details;
    expect(details).toContain('test (2/3)');
    expect(details).toContain('expected 1 to be 78');
    expect(checkPhase).toHaveBeenCalledTimes(2);
    expect(shipPhase).toHaveBeenCalledTimes(2);
    expect(shipPhase.mock.calls[1][0]).toMatchObject({ reentry: { prNumber: 9 } });
    expect(log).toHaveBeenCalledWith(
      'rework',
      expect.stringContaining('CI rework round 1/2: attributable failing check(s) test (2/3)'),
      expect.anything(),
    );
  });

  it('a non-CodeQL CI rework round merges the PR base into the worktree before the rework worker runs', async () => {
    shipPhase.mockResolvedValueOnce(TEST_FAIL).mockResolvedValueOnce(SUCCESS);
    await runIssue(request, policy, ports(vi.fn<Log>()));
    expect(mergeBaseIntoWorktree).toHaveBeenCalledWith('/tmp/wt', 'main');
    const merged = mergeBaseIntoWorktree.mock.invocationCallOrder[0];
    expect(merged).toBeLessThan(reworkWorker.mock.invocationCallOrder[0]);
    expect(merged).toBeLessThan(readWorktreeHead.mock.invocationCallOrder[0]);
  });

  it('a conflicting base merge parks conflict and runs no rework worker', async () => {
    shipPhase.mockResolvedValueOnce(TEST_FAIL);
    mergeBaseIntoWorktree.mockResolvedValue({ ok: false, conflict: true, paths: ['a.ts'] });
    expect(await runIssue(request, policy, ports(vi.fn<Log>()))).toMatchObject({
      state: 'parked',
      reason: 'conflict',
    });
    expect(reworkWorker).not.toHaveBeenCalled();
    expect(shipPhase).toHaveBeenCalledTimes(1);
  });

  it('a non-conflict merge failure parks ci-failed with the merge error and runs no rework', async () => {
    shipPhase.mockResolvedValueOnce(TEST_FAIL);
    mergeBaseIntoWorktree.mockResolvedValue({ ok: false, conflict: false, message: 'network down' });
    const log = vi.fn<Log>();
    expect(await runIssue(request, policy, ports(log))).toMatchObject({ state: 'parked', reason: 'ci-failed' });
    expect(reworkWorker).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      'ci-failed',
      expect.stringContaining('could not merge origin/main: network down'),
      expect.anything(),
    );
  });

  it('a non-CodeQL rework diff that raises a max-lines ceiling parks ci-failed suppression-attempt without SHIP re-entry', async () => {
    shipPhase.mockResolvedValueOnce(TEST_FAIL);
    readReworkDiff.mockResolvedValue(
      [
        'diff --git a/max-lines-baseline.json b/max-lines-baseline.json',
        '--- a/max-lines-baseline.json',
        '+++ b/max-lines-baseline.json',
        '@@ -3 +3 @@',
        '-  "packages/core/src/internal.ts": 789,',
        '+  "packages/core/src/internal.ts": 790,',
        '',
      ].join('\n'),
    );
    expect(await runIssue(request, policy, ports(vi.fn<Log>()))).toMatchObject({
      state: 'parked',
      reason: 'ci-failed',
    });
    expect(shipPhase).toHaveBeenCalledTimes(1);
    expect(checkPhase).toHaveBeenCalledTimes(1);
  });

  it('a non-CodeQL failure still red after the budget parks ci-failed as exhausted after 2 rounds', async () => {
    shipPhase.mockResolvedValue(TEST_FAIL);
    const log = vi.fn<Log>();
    expect(await runIssue(request, policy, ports(log))).toMatchObject({ state: 'parked', reason: 'ci-failed' });
    expect(reworkWorker).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith(
      'ci-failed',
      'ship phase failed: CI failed for PR #9 — CI rework budget exhausted after 2 rounds',
      expect.anything(),
    );
  });

  it('FACTORY_MAX_CI_REWORK_ROUNDS=0 runs no non-CodeQL rework round and no base merge', async () => {
    vi.stubEnv('FACTORY_MAX_CI_REWORK_ROUNDS', '0');
    shipPhase.mockResolvedValue(TEST_FAIL);
    expect(await runIssue(request, policy, ports(vi.fn<Log>()))).toMatchObject({
      state: 'parked',
      reason: 'ci-failed',
    });
    expect(reworkWorker).not.toHaveBeenCalled();
    expect(mergeBaseIntoWorktree).not.toHaveBeenCalled();
  });

  it('a failing CodeQL check with no alerts gets no non-CodeQL rework', async () => {
    shipPhase.mockResolvedValue({
      ...TEST_FAIL,
      ciFailure: { failingChecks: [{ name: 'CodeQL', conclusion: 'failure' }], alerts: [], truncated: false },
    });
    expect(await runIssue(request, policy, ports(vi.fn<Log>()))).toMatchObject({
      state: 'parked',
      reason: 'ci-failed',
    });
    expect(reworkWorker).not.toHaveBeenCalled();
    expect(mergeBaseIntoWorktree).not.toHaveBeenCalled();
  });
});

describe('shipWithCiRework — CodeQL data-flow alerts in unchanged files (#3712)', () => {
  const CI_FAIL: ShipResult = {
    ok: false,
    prNumber: 9,
    reason: 'CI failed for PR #9',
    ciOutcome: 'failure',
    ciFailure: {
      failingChecks: [
        { name: 'CodeQL', conclusion: 'failure', summary: 'New alerts in code changed by this pull request — 1 high' },
      ],
      alerts: [
        {
          ruleId: 'js/insecure-temporary-file',
          location: 'packages/core/src/daemon/run-store.ts:81',
          message: 'x',
          number: 230,
        },
      ],
      truncated: false,
    },
    headSha: 'sha',
  };
  const SUCCESS: ShipResult = { ok: true, prNumber: 9, ciOutcome: 'success' };

  beforeEach(() => {
    listPrChangedFiles.mockResolvedValue(['packages/core/src/daemon/factoryd-http.ts']);
  });

  it('an alert in an unchanged file absent on base gets one CI rework round', async () => {
    shipPhase.mockResolvedValueOnce(CI_FAIL).mockResolvedValueOnce(SUCCESS);
    const outcome = await runIssue(request, policy, ports(vi.fn<Log>()));
    expect(outcome).toMatchObject({ state: 'ready' });
    expect(reworkWorker).toHaveBeenCalledTimes(1);
    const call = reworkWorker.mock.calls[0][0];
    expect(call.summary.results[0].details).toContain('run-store.ts:81');
    expect(call.extraInstructions).toBe(CI_REWORK_INSTRUCTIONS);
  });

  it('the rework log carries the introduced-by-PR reason, not the baseline note', async () => {
    shipPhase.mockResolvedValueOnce(CI_FAIL).mockResolvedValueOnce(SUCCESS);
    const log = vi.fn<Log>();
    await runIssue(request, policy, ports(log));
    expect(JSON.stringify(log.mock.calls)).not.toContain('baseline: no CI failure is attributable');
    const rework = log.mock.calls.find((c) => c[0] === 'rework' && String(c[1]).includes('CI rework round 1/2'));
    expect(rework?.[2]).toMatchObject({
      ciFailure: { attribution: { items: [{ reason: 'not open on base main' }] } },
    });
  });

  it('an alert in an unchanged file open on base still parks ci-failed baseline', async () => {
    listBaseCodeqlAlerts.mockResolvedValue({ baseRef: 'main', numbers: [230], refs: [] });
    shipPhase.mockResolvedValue(CI_FAIL);
    const log = vi.fn<Log>();
    const outcome = await runIssue(request, policy, ports(log));
    expect(outcome).toMatchObject({ state: 'parked', reason: 'ci-failed' });
    expect(JSON.stringify(log.mock.calls)).toContain('baseline: no CI failure is attributable to this PR');
    expect(reworkWorker).not.toHaveBeenCalled();
  });

  it('a base-alert lookup error is logged and falls back to the CodeQL summary', async () => {
    listBaseCodeqlAlerts.mockRejectedValue(new Error('boom'));
    shipPhase.mockResolvedValueOnce(CI_FAIL).mockResolvedValueOnce(SUCCESS);
    const log = vi.fn<Log>();
    await runIssue(request, policy, ports(log));
    expect(JSON.stringify(log.mock.calls)).toContain('could not read base CodeQL alerts');
    expect(reworkWorker).toHaveBeenCalledTimes(1);
  });
});
