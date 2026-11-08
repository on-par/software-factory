import { join } from 'node:path';

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ReworkHistory } from '../checkers/rework-history.js';
import type { CheckPhaseResult } from '../phases/check.js';
import type { ShipResult } from '../phases/ship.js';
import type { CiFailureEvidence } from '../types/index.js';
import { CI_REWORK_INSTRUCTIONS } from './ci-rework.js';
import {
  breakerDir,
  CHECK_OK,
  checkPhase,
  collectFailingJobLogs,
  listBaseCodeqlAlerts,
  listBaseFailingChecks,
  listPrChangedFiles,
  type Log,
  mergeBaseIntoWorktree,
  policy,
  ports,
  readReworkDiff,
  readWorktreeHead,
  request,
  resetCiReworkMocks,
  reworkWorker,
  shipPhase,
  tmp,
} from './ci-rework-test-helpers.js';
import { runIssue } from './run-issue.js';

afterAll(() => tmp.cleanup());
beforeEach(resetCiReworkMocks);

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
      expect.stringContaining('ship phase failed: CI failed for PR #9 — CI rework budget exhausted after 2 rounds'),
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

describe('shipWithCiRework — log-attributed and diagnosed CI failures (#3998)', () => {
  const URL = 'https://github.com/o/r/actions/runs/1/job/5';
  const SHA = 'a1b2c3d4'.repeat(5);
  const GITLEAKS_FAIL: ShipResult = {
    ok: false,
    prNumber: 9,
    reason: 'CI failed for PR #9',
    ciOutcome: 'failure',
    ciFailure: {
      failingChecks: [{ name: 'gitleaks', conclusion: 'failure', url: URL }],
      alerts: [],
      truncated: false,
    },
    headSha: 'sha',
  };
  const SUCCESS: ShipResult = { ok: true, prNumber: 9, ciOutcome: 'success' };
  const gitleaksLog = (over: { files?: string[]; commits?: string[]; excerpt?: string } = {}) => ({
    jobLogs: [
      {
        name: 'gitleaks',
        jobId: 5,
        excerpt: 'leak <secret>',
        truncated: false,
        url: URL,
        files: ['src/a.ts'],
        ...over,
      },
    ],
    errors: [],
  });

  beforeEach(() => {
    listPrChangedFiles.mockResolvedValue(['src/a.ts']);
    listBaseFailingChecks.mockResolvedValue({ baseRef: 'main', baseSha: 'b'.repeat(40), failing: ['gitleaks'] });
  });

  it('a check also failing on base whose log names a PR-changed file gets a CI rework round (#3998)', async () => {
    collectFailingJobLogs.mockResolvedValue(gitleaksLog());
    shipPhase.mockResolvedValueOnce(GITLEAKS_FAIL).mockResolvedValueOnce(SUCCESS);
    const log = vi.fn<Log>();
    expect(await runIssue(request, policy, ports(log))).toMatchObject({ state: 'ready' });
    expect(reworkWorker).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.mock.calls)).not.toContain('baseline: no CI failure is attributable');
    expect(collectFailingJobLogs.mock.calls[0][0]).toMatchObject({
      checkNames: ['gitleaks'],
      changedFiles: ['src/a.ts'],
    });
  });

  it('the log-attributed rework summary names the check and carries a redacted log excerpt (#3998)', async () => {
    collectFailingJobLogs.mockResolvedValue(gitleaksLog({ excerpt: 'Secret: <secret> in src/a.ts' }));
    shipPhase.mockResolvedValueOnce(GITLEAKS_FAIL).mockResolvedValueOnce(SUCCESS);
    await runIssue(request, policy, ports(vi.fn<Log>()));
    const details = reworkWorker.mock.calls[0][0].summary.results[0].details;
    expect(details).toContain('gitleaks');
    expect(details).toContain('<secret>');
    expect(details).not.toContain('ghp_');
  });

  it('a baseline park message names the failing check, its run link, and the flagged files and commits (#3998)', async () => {
    collectFailingJobLogs.mockResolvedValue(gitleaksLog({ files: ['other.ts'], commits: [SHA] }));
    shipPhase.mockResolvedValue(GITLEAKS_FAIL);
    const log = vi.fn<Log>();
    expect(await runIssue(request, policy, ports(log))).toMatchObject({ state: 'parked', reason: 'ci-failed' });
    expect(reworkWorker).not.toHaveBeenCalled();
    const parked = log.mock.calls.find((c) => c[0] === 'ci-failed');
    const message = String(parked?.[1]);
    for (const part of ['baseline', 'gitleaks', URL, 'other.ts', SHA]) expect(message).toContain(part);
    expect(message).not.toContain('leak <secret>');
  });

  it('a budget-exhausted park message carries the failing check diagnosis (#3998)', async () => {
    listBaseFailingChecks.mockResolvedValue({ baseRef: 'main', baseSha: 'b'.repeat(40), failing: [] });
    collectFailingJobLogs.mockResolvedValue(gitleaksLog());
    shipPhase.mockResolvedValue(GITLEAKS_FAIL);
    const log = vi.fn<Log>();
    expect(await runIssue(request, policy, ports(log))).toMatchObject({ state: 'parked', reason: 'ci-failed' });
    expect(reworkWorker).toHaveBeenCalledTimes(2);
    const message = String(log.mock.calls.find((c) => c[0] === 'ci-failed')?.[1]);
    expect(message).toContain('budget exhausted');
    expect(message).toContain('gitleaks');
    expect(message).toContain(URL);
  });
});
