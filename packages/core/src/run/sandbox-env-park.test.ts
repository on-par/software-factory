import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Octokit } from '@octokit/rest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { testsChecker } from '../checkers/index.js';
import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { VERIFY_ENV_MARKER } from '../environment/sandbox-env.js';
import { createTempDirs } from '../harness/temp-dir.js';
import type { BuildResult, buildPhase as realBuildPhase } from '../phases/build.js';
import { checkPhase, type checkPhase as realCheckPhase } from '../phases/check.js';
import type { PlanResult, planPhase as realPlanPhase } from '../phases/plan.js';
import type { shipPhase as realShipPhase } from '../phases/ship.js';
import { ProviderBreaker } from '../router/breaker.js';
import { ModelRouter } from '../router/index.js';
import { StubModelExecutor } from '../router/stub.js';
import type { CheckerOutput } from '../types/index.js';
import type { WorkRequest } from '../work/index.js';
import type { RunPolicy } from './policy.js';
import type { Workspace } from './ports.js';
import { runIssue, type RunPorts, type RunRequest } from './run-issue.js';

const planPhase = vi.fn<typeof realPlanPhase>();
const buildPhase = vi.fn<typeof realBuildPhase>();
const checkPhaseMock = vi.fn<typeof realCheckPhase>();
const shipPhase = vi.fn<typeof realShipPhase>();

const PLAN_OK: PlanResult = { ok: true, route: 'codex', specPath: '/tmp/wt/spec.md', model: 'm', designArtifact: null };
const BUILD_OK: BuildResult = { ok: true, model: 'm', route: 'codex' };
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
const ROUTES: RoutesConfig = { version: 1, routes: { check_custom: { tier: 'boss', description: 'stub' } } };
const MODELS: ModelsConfig = {
  version: 1,
  models: {},
  tiers: {},
  failover: { triggers: [], maxRetries: 0, cooldownMs: 0, escalateAfterTierExhausted: false },
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

const tempDirs = createTempDirs();
const breakerDir = tempDirs.makeSync('sandbox-env-park-');
afterAll(() => tempDirs.cleanup());

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
    checkPhase: checkPhaseMock,
    shipPhase,
  };
}

const parkMessage = (log: ReturnType<typeof vi.fn<Log>>) =>
  String(log.mock.calls.find((c) => c[0] === 'sandbox-env')?.[1]);

beforeEach(() => {
  vi.mocked(shipPhase).mockReset();
  vi.mocked(planPhase).mockReset().mockResolvedValue(PLAN_OK);
  vi.mocked(buildPhase).mockReset().mockResolvedValue(BUILD_OK);
  vi.mocked(checkPhaseMock).mockReset();
});

/** The real checkPhase over the real testsChecker, with verify.sh stubbed to the given exit/stdout. */
async function realCheck(exitCode: number, stdout: string) {
  const worktree = await tempDirs.make('sandbox-env-wt-');
  await mkdir(join(worktree, 'scripts'), { recursive: true });
  await writeFile(join(worktree, 'scripts/verify.sh'), '#!/bin/bash\n');
  await writeFile(join(worktree, 'issue-3332.md'), '# spec\n');
  const router = new ModelRouter(MODELS, ROUTES, false, new StubModelExecutor({ defaultOutput: 'rework complete' }));
  const runBaseline = vi.fn(async () => ({ baseSha: 'abc1234567', checkers: [] }));
  const result = await checkPhase({
    issue: 3332,
    worktree,
    specPath: join(worktree, 'issue-3332.md'),
    router,
    constitution: null,
    maxReworkRounds: 1,
    diffBase: 'abc1234567',
    log: () => {},
    runBaseline: runBaseline as never,
    runCheckers: async (ctx) => {
      const tests: CheckerOutput = await testsChecker({
        ...ctx,
        runCommand: async (argv) => ({
          command: argv,
          stdout,
          stderr: '',
          exitCode,
          killed: false,
          timedOut: false,
          ok: false,
        }),
      });
      return { failures: 1, passes: 0, skips: 0, total: 1, results: [tests] };
    },
  });
  return { result, runBaseline };
}

describe('sandbox-env park (#3332)', () => {
  it('a loopback EPERM from verify.sh parks sandbox-env on the first hit with no rework (#3283, 2026-10-19)', async () => {
    const { result, runBaseline } = await realCheck(
      78,
      `${VERIFY_ENV_MARKER}\nverify: EPERM: tcp 127.0.0.1: listen EPERM\n`,
    );
    expect(result.sandboxEnv).toContain(VERIFY_ENV_MARKER);
    expect(result.reworkRounds).toBe(0);
    expect(runBaseline).not.toHaveBeenCalled();

    vi.mocked(checkPhaseMock).mockResolvedValue(result);
    const log = vi.fn<Log>();
    const outcome = await runIssue(request, policy, ports(log));
    expect(outcome).toMatchObject({ state: 'parked', reason: 'sandbox-env' });
    const message = parkMessage(log);
    expect(message).toContain('loopback bind denied');
    expect(message).toContain('#3081');
    expect(vi.mocked(checkPhaseMock)).toHaveBeenCalledTimes(1);
  });

  it('a BUILD ENV-ERROR line parks sandbox-env with the line and never runs CHECK', async () => {
    const line = 'ENV-ERROR: verify: ENVIRONMENT ERROR: loopback bind denied (EPERM)';
    vi.mocked(buildPhase).mockResolvedValue({
      ok: false,
      model: 'm',
      route: 'codex',
      reason: 'sandbox_env',
      envError: line,
    });
    const log = vi.fn<Log>();
    const outcome = await runIssue(request, policy, ports(log));
    expect(outcome).toMatchObject({ state: 'parked', reason: 'sandbox-env' });
    expect(parkMessage(log)).toContain(line);
    expect(checkPhaseMock).not.toHaveBeenCalled();
  });

  it('a verify.sh exit 1 with no marker is a test FAIL that goes to rework', async () => {
    const { result } = await realCheck(1, 'FAIL src/a.test.ts\n');
    expect(result.sandboxEnv).toBeUndefined();
    expect(result.reworkRounds).toBe(1);
  });
});
