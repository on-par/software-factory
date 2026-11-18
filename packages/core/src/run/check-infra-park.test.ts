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

  it('parks time-budget with the check failure and passes the parsed deadline to CHECK', async () => {
    const worktree = tempDirs.makeSync('time-budget-park-');
    const { calls: events, fn: log } = recordArgs((_type: string, _msg: string) => {});
    const message = 'time budget: skipped rework — needs ~20m, 4m left in the run budget\ntests: coverage';
    const seen: Parameters<NonNullable<RunPorts['checkPhase']>>[0][] = [];
    const checkPhase: RunPorts['checkPhase'] = async (o) => {
      seen.push(o);
      return { passed: false, summary: FAILED, reworkRounds: 0, failureSignature: 'tests:sig', timeBudget: message };
    };
    const deadline = '2026-11-18T01:50:00.000Z';
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
    expect(events).toContainEqual(['time-budget', expect.stringContaining(message), expect.anything()]);
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
