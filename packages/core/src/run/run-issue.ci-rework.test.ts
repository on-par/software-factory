import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Octokit } from '@octokit/rest';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
import type { reworkWorker as realReworkWorker } from '../phases/check.js';
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

const breakerDir = mkdtempSync(join(tmpdir(), 'run-issue-ci-rework-'));
afterAll(() => rmSync(breakerDir, { recursive: true, force: true }));

type Log = ReturnType<RunPorts['events']>;

const ciFailed = (msg: unknown, data: unknown) => ['ci-failed', msg, data];

const checkCalls: Parameters<typeof realCheckPhase>[0][] = [];
const shipCalls: Parameters<typeof realShipPhase>[0][] = [];
const reworkCalls: Parameters<typeof realReworkWorker>[0][] = [];
const diffReads: Array<[string, string]> = [];
const order: string[] = [];
const events: Parameters<Log>[] = [];
const log: Log = (...args) => events.push(args);

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
    checkPhase: async (o) => (checkCalls.push(o), checkPhase(o)),
    shipPhase: async (o) => (shipCalls.push(o), shipPhase(o)),
    reworkWorker: async (o) => (reworkCalls.push(o), order.push('reworkWorker'), reworkWorker(o)),
    readWorktreeHead: async (w) => (order.push('readWorktreeHead'), readWorktreeHead(w)),
    readReworkDiff: async (w, sha) => (diffReads.push([w, sha]), readReworkDiff(w, sha)),
    listPrChangedFiles: listPrChangedFiles as RunPorts['listPrChangedFiles'],
    listBaseFailingChecks: (async (...a: unknown[]) => (
      order.push('listBaseFailingChecks'),
      listBaseFailingChecks(...a)
    )) as RunPorts['listBaseFailingChecks'],
    mergeBaseIntoWorktree: async (...a) => (order.push('mergeBaseIntoWorktree'), mergeBaseIntoWorktree(...a)),
    collectFailingJobLogs,
  };
}

beforeEach(() => {
  for (const arr of [checkCalls, shipCalls, reworkCalls, diffReads, order, events]) arr.length = 0;
  vi.mocked(planPhase).mockReset().mockResolvedValue(PLAN_OK);
  vi.mocked(buildPhase).mockReset().mockResolvedValue(BUILD_OK);
  vi.mocked(checkPhase).mockReset().mockResolvedValue(CHECK_OK);
  shipPhase.mockReset();
  reworkWorker.mockReset().mockResolvedValue({ failovers: [], modelCompleted: true });
  readWorktreeHead.mockReset().mockResolvedValue('a'.repeat(40));
  readReworkDiff.mockReset().mockResolvedValue('');
  listPrChangedFiles.mockReset().mockResolvedValue(['packages/core/src/sandbox/egress-proxy.ts']);
  listBaseFailingChecks.mockReset().mockResolvedValue({ baseRef: 'main', baseSha: 'b'.repeat(40), failing: [] });
  mergeBaseIntoWorktree.mockReset().mockResolvedValue({ ok: true, merged: false });
  collectFailingJobLogs.mockReset().mockResolvedValue({ jobLogs: [], errors: [] });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('runIssue — SHIP CI rework loop (#2816)', () => {
  const EVIDENCE: CiFailureEvidence = {
    failingChecks: [{ name: 'CodeQL', conclusion: 'failure', summary: '1 new alert' }],
    alerts: [
      {
        ruleId: 'js/request-forgery',
        location: 'packages/core/src/sandbox/egress-proxy.ts:130',
        message: 'tainted url',
      },
    ],
    truncated: false,
  };
  const ATTRIBUTED = expect.objectContaining({
    ...EVIDENCE,
    attribution: expect.objectContaining({ baseline: false }),
  });
  const CI_FAIL = {
    ok: false,
    prNumber: 9,
    reason: 'CI failed for PR #9',
    ciOutcome: 'failure',
    ciFailure: EVIDENCE,
    headSha: 'sha',
  } as const;

  it('reworks an attributable CodeQL failure once with rule id, file:line and message and forbids suppression', async () => {
    shipPhase.mockResolvedValueOnce(CI_FAIL).mockResolvedValueOnce({ ok: true, prNumber: 9, ciOutcome: 'success' });
    const outcome = await runIssue(request, policy, ports(log));
    expect(outcome).toMatchObject({ state: 'ready' });
    expect(reworkCalls).toHaveLength(1);
    const opts = reworkCalls[0];
    const details = opts.summary.results[0].details;
    expect(details).toContain('js/request-forgery');
    expect(details).toContain('packages/core/src/sandbox/egress-proxy.ts:130');
    expect(details).toContain('tainted url');
    expect(opts.extraInstructions).toMatch(/suppression is forbidden/i);
    expect(opts.onWorkerResult).toBe(checkCalls[0].onWorkerResult);
    expect(checkCalls).toHaveLength(2);
    expect(shipCalls).toHaveLength(2);
    expect(shipCalls[1].reentry).toEqual({ prNumber: 9, previousHeadSha: 'sha' });
    expect(shipCalls[0].reentry).toBeUndefined();
  });

  it('a CI rework re-ship failure parks with the ship reason in the park comment', async () => {
    const reason = 'remote head X does not match local HEAD Y for b';
    shipPhase.mockResolvedValueOnce(CI_FAIL).mockResolvedValueOnce({ ok: false, reason });
    const bodies: string[] = [];
    const octokit = Object.assign({} as Octokit, {
      rest: {
        users: { getAuthenticated: async () => ({ data: { id: 9 } }) },
        issues: {
          listComments: async () => ({ data: [] }),
          createComment: async (args: { body: string }) => (bodies.push(args.body), { data: { id: 1 } }),
          updateComment: async () => ({ data: { id: 1 } }),
        },
      },
    });
    expect(await runIssue(request, policy, { ...ports(log), octokit })).toMatchObject({ state: 'parked' });
    expect(events.some(([, msg]) => msg.includes(`ship phase failed: ${reason}`))).toBe(true);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain(reason);
  });

  it('parks ci-failed as exhausted with evidence after the second CI rework round and runs no third rework', async () => {
    shipPhase.mockResolvedValue(CI_FAIL);
    expect(await runIssue(request, policy, ports(log))).toMatchObject({ state: 'parked', reason: 'ci-failed' });
    expect(reworkCalls).toHaveLength(2);
    expect(shipCalls).toHaveLength(3);
    expect(events).toContainEqual(
      ciFailed(
        expect.stringContaining('ship phase failed: CI failed for PR #9 — CI rework budget exhausted after 2 rounds'),
        expect.objectContaining({ ciFailure: ATTRIBUTED }),
      ),
    );
  });

  it('CI rework budget is independent of CHECK reworkRounds and honors the env override', async () => {
    vi.stubEnv('FACTORY_MAX_CI_REWORK_ROUNDS', '1');
    vi.mocked(checkPhase).mockResolvedValue({ ...CHECK_OK, reworkRounds: 1 });
    shipPhase.mockResolvedValue(CI_FAIL);
    expect(await runIssue(request, policy, ports(log))).toMatchObject({ state: 'parked', reason: 'ci-failed' });
    expect(reworkCalls).toHaveLength(1);
    expect(events).toContainEqual(
      ciFailed(
        expect.stringContaining('ship phase failed: CI failed for PR #9 — CI rework budget exhausted after 1 round'),
        expect.objectContaining({ ciFailure: ATTRIBUTED }),
      ),
    );
  });

  it('parks ci-failed as baseline with zero rework calls when every CodeQL alert is outside the changed files', async () => {
    listPrChangedFiles.mockResolvedValue(['other.ts']);
    shipPhase.mockResolvedValue(CI_FAIL);
    expect(await runIssue(request, policy, ports(log))).toMatchObject({ state: 'parked', reason: 'ci-failed' });
    expect(reworkCalls).toHaveLength(0);
    expect(order).not.toContain('listBaseFailingChecks');
    expect(events).toContainEqual(
      ciFailed(
        expect.stringContaining(
          'ship phase failed: CI failed for PR #9 — baseline: no CI failure is attributable to this PR',
        ),
        expect.objectContaining({
          ciFailure: expect.objectContaining({
            attribution: expect.objectContaining({
              baseline: true,
              items: [expect.objectContaining({ kind: 'codeql-alert', attributable: false })],
            }),
          }),
        }),
      ),
    );
  });

  const TEST_EVIDENCE: CiFailureEvidence = {
    failingChecks: [{ name: 'test', conclusion: 'failure' }],
    alerts: [],
    truncated: false,
  };
  const TEST_FAIL = { ...CI_FAIL, ciFailure: TEST_EVIDENCE };

  it('parks ci-failed as baseline with zero rework calls when the failing check also fails on the base commit', async () => {
    listBaseFailingChecks.mockResolvedValue({ baseRef: 'main', baseSha: 'b'.repeat(40), failing: ['test'] });
    shipPhase.mockResolvedValue(TEST_FAIL);
    expect(await runIssue(request, policy, ports(log))).toMatchObject({ state: 'parked', reason: 'ci-failed' });
    expect(reworkCalls).toHaveLength(0);
    expect(order).not.toContain('mergeBaseIntoWorktree');
    expect(checkCalls).toHaveLength(1);
    expect(events).toContainEqual(
      ciFailed(
        expect.stringContaining('baseline'),
        expect.objectContaining({
          ciFailure: expect.objectContaining({ attribution: expect.objectContaining({ baseline: true }) }),
        }),
      ),
    );
  });

  it('reworks a check not failing on base', async () => {
    shipPhase.mockResolvedValueOnce(TEST_FAIL).mockResolvedValueOnce({ ok: true, prNumber: 9, ciOutcome: 'success' });
    expect(await runIssue(request, policy, ports(log))).toMatchObject({ state: 'ready' });
    expect(reworkCalls).toHaveLength(1);
  });

  it('parks ci-failed without baseline when the base lookup throws', async () => {
    listBaseFailingChecks.mockRejectedValue(new Error('nope'));
    shipPhase.mockResolvedValue(TEST_FAIL);
    expect(await runIssue(request, policy, ports(log))).toMatchObject({ reason: 'ci-failed' });
    expect(reworkCalls).toHaveLength(0);
    expect(order).not.toContain('mergeBaseIntoWorktree');
    expect(events).toContainEqual(ciFailed('ship phase failed: CI failed for PR #9', expect.anything()));
  });

  it('reworks the attributable alert in a mixed failure and marks the base-failing check non-attributable in the evidence', async () => {
    listBaseFailingChecks.mockResolvedValue({ baseRef: 'main', baseSha: 'b'.repeat(40), failing: ['test'] });
    const mixed = {
      ...CI_FAIL,
      ciFailure: { ...EVIDENCE, failingChecks: [...EVIDENCE.failingChecks, { name: 'test', conclusion: 'failure' }] },
    };
    shipPhase.mockResolvedValueOnce(mixed).mockResolvedValueOnce({ ok: true, prNumber: 9, ciOutcome: 'success' });
    expect(await runIssue(request, policy, ports(log))).toMatchObject({ state: 'ready' });
    expect(reworkCalls).toHaveLength(1);
    expect(reworkCalls[0].summary.results[0].details).toContain('js/request-forgery');
    const call = events.find((c) => c[0] === 'rework') ?? [];
    expect(call[1]).toContain('non-attributable: test');
    const items = (call[2] as { ciFailure: CiFailureEvidence }).ciFailure.attribution?.items;
    expect(items).toEqual([
      expect.objectContaining({ kind: 'codeql-alert', attributable: true }),
      expect.objectContaining({ kind: 'check', ref: 'test', attributable: false }),
    ]);
  });

  it('parks ci-failed with no rework when the changed-files lookup throws', async () => {
    listPrChangedFiles.mockRejectedValue(new Error('boom'));
    shipPhase.mockResolvedValue(CI_FAIL);
    expect(await runIssue(request, policy, ports(log))).toMatchObject({ reason: 'ci-failed' });
    expect(reworkCalls).toHaveLength(0);
  });

  it('parks ci-failed without a second CHECK when the rework worker never ran', async () => {
    reworkWorker.mockResolvedValue({ failovers: [], modelCompleted: false });
    shipPhase.mockResolvedValue(CI_FAIL);
    expect(await runIssue(request, policy, ports(log))).toMatchObject({ reason: 'ci-failed' });
    expect(checkCalls).toHaveLength(1);
    expect(events).toContainEqual(
      ciFailed(
        'ship phase failed: CI failed for PR #9 — CI rework worker never ran',
        expect.objectContaining({ ciFailure: ATTRIBUTED }),
      ),
    );
  });

  it('parks fail when the re-CHECK fails', async () => {
    shipPhase.mockResolvedValue(CI_FAIL);
    vi.mocked(checkPhase)
      .mockResolvedValueOnce(CHECK_OK)
      .mockResolvedValueOnce({ ...CHECK_OK, passed: false, summary: { ...CHECK_OK.summary, failures: 1 } });
    const outcome = await runIssue(request, policy, ports(log));
    expect(outcome).toMatchObject({ state: 'parked', reason: 'fail' });
    expect(shipCalls).toHaveLength(1);
  });

  const parkedSuppression = (rule: string) =>
    expect.objectContaining({
      ciFailure: expect.objectContaining({
        suppressionAttempt: expect.arrayContaining([expect.objectContaining({ rule })]),
      }),
    });

  it('parks ci-failed suppression-attempt when the CI rework diff adds a suppression comment, without re-CHECK or SHIP re-entry', async () => {
    shipPhase.mockResolvedValueOnce(CI_FAIL);
    readReworkDiff.mockResolvedValue(
      'diff --git a/packages/core/src/sandbox/egress-proxy.ts b/packages/core/src/sandbox/egress-proxy.ts\n' +
        '--- a/packages/core/src/sandbox/egress-proxy.ts\n+++ b/packages/core/src/sandbox/egress-proxy.ts\n' +
        '@@ -130,0 +130,1 @@\n+// codeql[js/request-forgery]\n',
    );
    expect(await runIssue(request, policy, ports(log))).toMatchObject({ state: 'parked', reason: 'ci-failed' });
    expect(reworkCalls).toHaveLength(1);
    expect(checkCalls).toHaveLength(1);
    expect(shipCalls).toHaveLength(1);
    expect(events).toContainEqual(
      ciFailed(expect.stringContaining('suppression-attempt'), parkedSuppression('codeql-comment')),
    );
  });

  it.each([
    ['.github/workflows/codeql.yml', 'workflow-path'],
    ['.github/codeql/codeql-config.yml', 'codeql-path'],
    ['out.sarif', 'sarif-path'],
  ])(
    'parks ci-failed suppression-attempt when the CI rework diff touches a workflow, CodeQL config or sarif file (%s)',
    async (path, rule) => {
      shipPhase.mockResolvedValueOnce(CI_FAIL);
      readReworkDiff.mockResolvedValue(
        `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n+x\n`,
      );
      expect(await runIssue(request, policy, ports(log))).toMatchObject({ state: 'parked', reason: 'ci-failed' });
      expect(checkCalls).toHaveLength(1);
      expect(shipCalls).toHaveLength(1);
      expect(events).toContainEqual(ciFailed(expect.stringContaining('suppression-attempt'), parkedSuppression(rule)));
    },
  );

  it('parks ci-failed suppression-attempt when the rework diff cannot be read', async () => {
    shipPhase.mockResolvedValueOnce(CI_FAIL);
    readReworkDiff.mockRejectedValue(new Error('git exploded'));
    expect(await runIssue(request, policy, ports(log))).toMatchObject({ state: 'parked', reason: 'ci-failed' });
    expect(shipCalls).toHaveLength(1);
    expect(events).toContainEqual(ciFailed(expect.stringContaining('git exploded'), parkedSuppression('guard-error')));
  });

  it('parks ci-failed suppression-attempt without running rework when the pre-rework HEAD cannot be read', async () => {
    shipPhase.mockResolvedValueOnce(CI_FAIL);
    readWorktreeHead.mockRejectedValue(new Error('no head'));
    expect(await runIssue(request, policy, ports(log))).toMatchObject({ state: 'parked', reason: 'ci-failed' });
    expect(reworkCalls).toHaveLength(0);
    expect(events).toContainEqual(
      ciFailed(expect.stringContaining('suppression-attempt'), parkedSuppression('guard-error')),
    );
  });

  it('a clean CI rework diff passes the suppression guard and re-enters SHIP with the previous head SHA', async () => {
    shipPhase.mockResolvedValueOnce(CI_FAIL).mockResolvedValueOnce({ ok: true, prNumber: 9, ciOutcome: 'success' });
    expect(await runIssue(request, policy, ports(log))).toMatchObject({ state: 'ready' });
    expect(diffReads).toEqual([['/tmp/wt', 'a'.repeat(40)]]);
    expect(order.indexOf('readWorktreeHead')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('readWorktreeHead')).toBeLessThan(order.indexOf('reworkWorker'));
    expect(shipCalls).toHaveLength(2);
    expect(shipCalls[1].reentry).toEqual({ prNumber: 9, previousHeadSha: 'sha' });
  });
});

describe('draft PR (#3449)', () => {
  it.each(['Custom footer', ''])('every CI-rework SHIP re-entry keeps draft and footer %j', async (footer) => {
    const ciFailure: CiFailureEvidence = {
      failingChecks: [{ name: 'CodeQL', conclusion: 'failure', summary: '1 new alert' }],
      alerts: [
        {
          ruleId: 'js/request-forgery',
          location: 'packages/core/src/sandbox/egress-proxy.ts:130',
          message: 'tainted url',
        },
      ],
      truncated: false,
    };
    shipPhase
      .mockResolvedValueOnce({
        ok: false,
        prNumber: 9,
        reason: 'CI failed for PR #9',
        ciOutcome: 'failure',
        ciFailure,
        headSha: 'sha',
      })
      .mockResolvedValueOnce({ ok: true, prNumber: 9, ciOutcome: 'success', draft: true });
    const outcome = await runIssue(
      request,
      { ...policy, pr: { draft: true, footer, walkthrough: { minLines: 7 }, evidenceComment: true } },
      ports(log),
    );
    expect(outcome).toMatchObject({ state: 'ready', prNumber: 9, draft: true });
    for (const call of shipCalls) {
      expect(call.draft).toBe(true);
      expect(call.footer).toBe(footer);
      expect(call.walkthrough).toEqual({ minLines: 7 });
      expect(call.evidenceComment).toBe(true);
    }
    expect(events.some(([t, m]) => t === 'ready' && m.includes('PR #9 left as draft'))).toBe(true);
  });

  it('passes no draft option when the policy has none', async () => {
    shipPhase.mockResolvedValueOnce({ ok: true, prNumber: 9, ciOutcome: 'success' });
    expect(await runIssue(request, policy, ports(log))).not.toHaveProperty('draft');
    expect(shipCalls[0].draft).toBeUndefined();
    expect(shipCalls[0].footer).toBeUndefined();
    expect(shipCalls[0].walkthrough).toBeUndefined();
    expect(shipCalls[0].evidenceComment).toBeUndefined();
  });
});
