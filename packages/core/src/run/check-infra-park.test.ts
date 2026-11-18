import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Octokit } from '@octokit/rest';
import { afterAll, describe, expect, it, vi } from 'vitest';

import { checkInfraParkMessage } from '../checkers/triage.js';
import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { createTempDirs } from '../harness/temp-dir.js';
import type { BuildResult } from '../phases/build.js';
import { checkPhase as realCheckPhase } from '../phases/check.js';
import type { PlanResult } from '../phases/plan.js';
import { ProviderBreaker } from '../router/breaker.js';
import { ModelRouter } from '../router/index.js';
import type { CheckSummary } from '../types/index.js';
import type { WorkRequest } from '../work/index.js';
import { parkUnblockHint } from './park-comment.js';
import type { RunPolicy } from './policy.js';
import type { Workspace } from './ports.js';
import { runIssue, type RunPorts, type RunRequest } from './run-issue.js';
import { workKeyFromIssue } from '../work/work-key.js';
import { recordArgs } from '../test-support/recorders.js';
import { commentStoreOctokit } from '../test-support/comment-store.js';
import { makeRepo } from '../test-support/git-repo.js';
import { requestRunStop } from './run-stop.js';

const tempDirs = createTempDirs();
afterAll(() => tempDirs.cleanup());

const MODELS: ModelsConfig = {
  version: 1,
  models: {},
  tiers: {},
  failover: { triggers: [], maxRetries: 0, cooldownMs: 0 },
  routingRules: {},
};
const ROUTES: RoutesConfig = { version: 1, routes: {} };
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
  localOnly: true,
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
const PLAN_OK: PlanResult = { ok: true, route: 'codex', specPath: '/tmp/wt/spec.md', model: 'm', designArtifact: null };
const BUILD_OK: BuildResult = { ok: true, model: 'm', route: 'codex' };

type Log = ReturnType<RunPorts['events']>;

const ECONNRESET_SUMMARY: CheckSummary = {
  failures: 1,
  passes: 0,
  skips: 0,
  total: 1,
  results: [{ checker: 'tests', result: 'FAIL', details: 'boom\nread ECONNRESET\nat x' }],
};

function ports(log: Log, worktree: string, checkPhase: RunPorts['checkPhase']): RunPorts {
  return {
    router: new ModelRouter(MODELS, ROUTES),
    octokit: {} as Octokit,
    workspace: { path: worktree, dispose: async () => {} } as Workspace,
    events: () => log,
    breaker: new ProviderBreaker(join(tempDirs.makeSync('check-infra-breaker-'), 'breaker.json')),
    resolveConstitution: () => null,
    planPhase: vi.fn().mockResolvedValue(PLAN_OK),
    shipPhase: vi.fn(),
    buildPhase: vi.fn().mockResolvedValue(BUILD_OK),
    checkPhase,
  };
}

describe('runIssue — check-infra park (#3371)', () => {
  it('a repeated ECONNRESET in CHECK parks check-infra with the matching line', async () => {
    const worktree = tempDirs.makeSync('check-infra-park-');
    await mkdir(join(worktree, 'scripts'), { recursive: true });
    await writeFile(join(worktree, 'scripts', 'verify.sh'), '#!/usr/bin/env bash\n');
    const { calls: events, fn: log } = recordArgs((_type: string, _msg: string) => {});
    const checkerRuns = recordArgs(async () => ECONNRESET_SUMMARY);
    const checkPhase: RunPorts['checkPhase'] = (o) =>
      realCheckPhase({
        ...o,
        worktree,
        runCheckers: checkerRuns.fn as never,
        runCommand: (async () => ({
          command: [],
          stdout: '',
          stderr: '',
          exitCode: 1,
          killed: false,
          timedOut: false,
          ok: false,
        })) as never,
        runEvidence: vi.fn().mockResolvedValue(undefined) as never,
      });

    const outcome = await runIssue(request, policy, ports(log, worktree, checkPhase));
    expect(outcome).toMatchObject({ state: 'parked', reason: 'check-infra' });
    expect(checkerRuns.calls).toHaveLength(2);
    const parked = expect.stringContaining(checkInfraParkMessage('tests', 'read ECONNRESET'));
    expect(events).toContainEqual(['check-infra', parked, expect.anything()]);
  });

  it('has a park hint naming the infrastructure cause', () => {
    const hint = parkUnblockHint('check-infra', workKeyFromIssue(7));
    expect(hint).toContain('infrastructure');
    expect(hint).toContain('factory unpark 7');
  });
});

describe('runIssue — time-budget park (#4264)', () => {
  const FAILED: CheckSummary = {
    failures: 1,
    passes: 0,
    skips: 0,
    total: 1,
    results: [{ checker: 'tests', result: 'FAIL', details: 'coverage 96.87% < 96.9%' }],
  };

  it('hands off with the check failure and passes the parsed deadline to CHECK', async () => {
    const worktree = tempDirs.makeSync('time-budget-park-');
    const { calls: events, fn: log } = recordArgs((_type: string, _msg: string) => {});
    const message = 'time budget: skipped rework — needs ~20m, 4m left in the run budget\ntests: coverage';
    const seen: Parameters<NonNullable<RunPorts['checkPhase']>>[0][] = [];
    const checkPhase: RunPorts['checkPhase'] = async (o) => {
      seen.push(o);
      return { passed: false, summary: FAILED, reworkRounds: 0, failureSignature: 'tests:sig', timeBudget: message };
    };
    const deadline = '2099-01-01T00:00:00.000Z';
    const outcome = await runIssue(
      { ...request, runDeadlineAt: deadline, checkTimeBudget: { verifyMinutes: 9 } },
      policy,
      ports(log, worktree, checkPhase),
    );
    expect(outcome).toMatchObject({
      state: 'parked',
      reason: 'time-budget',
      failureSignature: 'tests:sig',
      failingChecks: ['tests'],
    });
    expect(seen[0]).toMatchObject({
      runDeadlineAtMs: Date.parse(deadline),
      timeBudget: { verifyMinutes: 9 },
    });
    expect(outcome).toMatchObject({
      handoff: { phase: 'check', nextStep: 'Fix tests on the run branch, then re-run CHECK.' },
    });
    expect(events).toContainEqual(['time-budget', expect.stringContaining('budget exhausted'), expect.anything()]);
  });

  it('warns and runs without a deadline when the value does not parse', async () => {
    const worktree = tempDirs.makeSync('time-budget-bad-');
    const { calls: events, fn: log } = recordArgs((_type: string, _msg: string) => {});
    const seen: Parameters<NonNullable<RunPorts['checkPhase']>>[0][] = [];
    const checkPhase: RunPorts['checkPhase'] = async (o) => {
      seen.push(o);
      return { passed: false, summary: FAILED, reworkRounds: 1 };
    };
    await runIssue({ ...request, runDeadlineAt: 'soon' }, policy, ports(log, worktree, checkPhase));
    expect(seen[0]?.runDeadlineAtMs).toBeUndefined();
    expect(events).toContainEqual([
      'environment_warning',
      expect.stringContaining("FACTORY_RUN_DEADLINE_AT='soon' is not epoch ms or ISO-8601"),
    ]);
  });

  it('has a park hint naming the run deadline', () => {
    const hint = parkUnblockHint('time-budget', workKeyFromIssue(7));
    expect(hint).toContain('FACTORY_RUN_DEADLINE_AT');
    expect(hint).toContain('factory unpark 7');
  });
});

describe('runIssue — remaining-work handoff (#4269)', () => {
  const DEADLINE = Date.parse('2026-11-18T02:00:00.000Z');
  const FAILED: CheckSummary = {
    failures: 1,
    passes: 0,
    skips: 0,
    total: 1,
    results: [{ checker: 'tests', result: 'FAIL', details: 'killed by SIGTERM' }],
  };
  const handoffRequest: RunRequest = {
    ...request,
    issue: 7,
    branch: 'issue-7-x',
    work: { ...WORK, acceptanceCriteria: ['Stops with a handoff. proof: run test', 'Docs updated'] },
    runDeadlineAt: new Date(DEADLINE).toISOString(),
  };
  const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

  it('a budget that expires during BUILD parks with a handoff listing every criterion as remaining', async () => {
    const worktree = makeRepo(tempDirs, 'handoff-build-', { 'a.txt': 'a' });
    const { calls: events, fn: log } = recordArgs((_type: string, _msg: string) => {});
    let now = DEADLINE - 60 * 60_000;
    let checked = false;
    const checkPhase: RunPorts['checkPhase'] = async () => {
      checked = true;
      return { passed: true, summary: FAILED, reworkRounds: 0 };
    };
    const outcome = await runIssue(handoffRequest, policy, {
      ...ports(log, worktree, checkPhase),
      now: () => now,
      buildPhase: async () => {
        writeFileSync(join(worktree, 'b.txt'), 'half done');
        now = DEADLINE - 60_000;
        return BUILD_OK;
      },
    });
    expect(outcome).toMatchObject({
      state: 'parked',
      reason: 'time-budget',
      handoff: {
        version: 1,
        stopReason: 'deadline',
        phase: 'build',
        wipBranch: 'wip/issue-7-x',
        fitsOneRun: false,
        criteria: [
          { criterion: 'Stops with a handoff.', proof: 'run test', status: 'not_started' },
          { criterion: 'Docs updated', proof: null, status: 'not_started' },
        ],
      },
    });
    expect(checked).toBe(false);
    expect(git(worktree, ['rev-parse', 'wip/issue-7-x'])).toBe(git(worktree, ['rev-parse', 'HEAD']));
    expect(events).toContainEqual(['time-budget', expect.stringContaining('budget exhausted'), expect.anything()]);
  });

  it('SIGTERM during CHECK pushes the WIP branch and posts one handoff comment', async () => {
    const worktree = makeRepo(tempDirs, 'handoff-check-', { 'a.txt': 'a' });
    const origin = tempDirs.makeSync('handoff-origin-');
    git(origin, ['init', '-q', '--bare']);
    git(worktree, ['remote', 'add', 'origin', origin]);
    git(worktree, ['push', '-q', 'origin', 'HEAD:refs/heads/main']);
    const { calls: events, fn: log } = recordArgs((_type: string, _msg: string) => {});
    const { store, octokit } = commentStoreOctokit();
    const checkPhase: RunPorts['checkPhase'] = async (o) => {
      writeFileSync(join(worktree, 'c.txt'), 'rework');
      requestRunStop();
      expect(o.stopRequested?.()).toBe(true);
      return { passed: false, summary: FAILED, reworkRounds: 0, failureSignature: 'tests:sig' };
    };
    const outcome = await runIssue(
      { ...handoffRequest, localOnly: false, runDeadlineAt: undefined, parentBaseRef: 'origin/main' },
      policy,
      {
        ...ports(log, worktree, checkPhase),
        octokit,
      },
    );
    expect(outcome).toMatchObject({
      state: 'parked',
      reason: 'time-budget',
      failureSignature: 'tests:sig',
      failingChecks: ['tests'],
      handoff: {
        stopReason: 'sigterm',
        phase: 'check',
        fitsOneRun: true,
        lastFailure: 'tests: killed by SIGTERM',
        criteria: [{ status: 'failing' }, { status: 'failing' }],
      },
    });
    const handoff = outcome.state === 'parked' ? outcome.handoff : undefined;
    expect(git(origin, ['rev-parse', 'refs/heads/wip/issue-7-x'])).toBe(handoff?.headSha);
    expect(handoff?.baseSha).toBe(git(origin, ['rev-parse', 'refs/heads/main']));
    const handoffComments = store.filter((c) => c.body.includes('<!-- factory-handoff v1 issue:7 -->'));
    expect(handoffComments).toHaveLength(1);
    expect(store.find((c) => c.body.includes('factory-issue-state'))?.body).toContain('budget exhausted: SIGTERM');
    expect(events).toContainEqual(['time-budget', expect.stringContaining('during CHECK'), expect.anything()]);
  });
});
