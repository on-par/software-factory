import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Octokit } from '@octokit/rest';
import { afterAll, describe, expect, it, vi } from 'vitest';

import { testsChecker } from '../checkers/index.js';
import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { VERIFY_SANDBOX_ENV_MARKER } from '../environment/sandbox-env.js';
import { createTempDirs } from '../harness/temp-dir.js';
import type { BuildResult } from '../phases/build.js';
import { buildPhase as realBuildPhase } from '../phases/build.js';
import { checkPhase as realCheckPhase } from '../phases/check.js';
import type { PlanResult } from '../phases/plan.js';
import { ProviderBreaker } from '../router/breaker.js';
import { ModelRouter } from '../router/index.js';
import { StubModelExecutor } from '../router/stub.js';
import type { CheckSummary } from '../types/index.js';
import type { CommandResult } from '../utils/command-runner.js';
import type { WorkRequest } from '../work/index.js';
import type { RunPolicy } from './policy.js';
import type { Workspace } from './ports.js';
import { runIssue, type RunPorts, type RunRequest } from './run-issue.js';

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
const BUILD_MODELS: ModelsConfig = {
  ...MODELS,
  models: {
    'stub-worker': {
      provider: 'custom',
      tier: 'worker',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
    },
  },
  tiers: { worker: ['stub-worker'] },
};
const BUILD_ROUTES: RoutesConfig = { version: 1, routes: { build_claude: { tier: 'worker', description: 'stub' } } };

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

async function worktreeWithVerify(): Promise<string> {
  const dir = tempDirs.makeSync('sandbox-env-park-');
  await mkdir(join(dir, 'scripts'), { recursive: true });
  await writeFile(join(dir, 'scripts', 'verify.sh'), '#!/usr/bin/env bash\n');
  return dir;
}

function basePorts(log: Log, worktree: string): Omit<RunPorts, 'buildPhase' | 'checkPhase'> {
  return {
    router: new ModelRouter(MODELS, ROUTES),
    octokit: {} as Octokit,
    workspace: { path: worktree, dispose: async () => {} } as Workspace,
    events: () => log,
    breaker: new ProviderBreaker(join(tempDirs.makeSync('sandbox-env-breaker-'), 'breaker.json')),
    resolveConstitution: () => null,
    planPhase: vi.fn().mockResolvedValue(PLAN_OK),
    shipPhase: vi.fn(),
  };
}

function testsResult(over: Partial<CommandResult>): (cmd: readonly string[]) => Promise<CommandResult> {
  return async (command) => ({
    command,
    stdout: '',
    stderr: '',
    exitCode: 1,
    killed: false,
    timedOut: false,
    ok: false,
    ...over,
  });
}

/** runIssue ports whose checkPhase runs the real phase over a real testsChecker fed a canned verify.sh result. */
function checkPorts(log: Log, worktree: string, verify: Partial<CommandResult>) {
  const runBaseline = vi.fn().mockResolvedValue({ baseSha: 'abc', checkers: [] });
  const runCheckers = vi.fn(async (ctx: Parameters<typeof testsChecker>[0]): Promise<CheckSummary> => {
    const tests = await testsChecker({ ...ctx, runCommand: testsResult(verify) });
    return { failures: 1, passes: 0, skips: 0, total: 1, results: [tests] };
  });
  const checkPhase: RunPorts['checkPhase'] = (o) =>
    realCheckPhase({
      ...o,
      worktree,
      diffBase: 'abc',
      runCheckers: runCheckers as never,
      runBaseline,
      runEvidence: vi.fn().mockResolvedValue(undefined) as never,
    });
  const ports: RunPorts = { ...basePorts(log, worktree), buildPhase: vi.fn().mockResolvedValue(BUILD_OK), checkPhase };
  return { ports, runBaseline, runCheckers };
}

describe('runIssue — sandbox environment park (#3332)', () => {
  it('a loopback EPERM from verify.sh parks sandbox-env on the first hit with no rework (#3283, 2026-10-19)', async () => {
    const worktree = await worktreeWithVerify();
    const log = vi.fn<Log>();
    const { ports, runBaseline, runCheckers } = checkPorts(log, worktree, {
      exitCode: 78,
      stdout: `${VERIFY_SANDBOX_ENV_MARKER}\n`,
    });

    const outcome = await runIssue(request, policy, ports);

    expect(outcome).toMatchObject({ state: 'parked', reason: 'sandbox-env' });
    expect(runBaseline).not.toHaveBeenCalled();
    expect(runCheckers).toHaveBeenCalledTimes(1);
    expect(log.mock.calls.some(([kind]) => kind === 'sandbox-env')).toBe(true);
  });

  it('a BUILD ENV-ERROR line parks sandbox-env with the line in the park message and never runs CHECK', async () => {
    const worktree = await worktreeWithVerify();
    const log = vi.fn<Log>();
    const line = `ENV-ERROR: ${VERIFY_SANDBOX_ENV_MARKER}`;
    const stub = new StubModelExecutor({ scripts: { build_claude: [{ output: `tried\n${line}` }] } });
    const checkPhase = vi.fn();
    const ports: RunPorts = {
      ...basePorts(log, worktree),
      buildPhase: (o) =>
        realBuildPhase({ ...o, router: new ModelRouter(BUILD_MODELS, BUILD_ROUTES, false, stub), route: 'claude' }),
      checkPhase,
    };

    const outcome = await runIssue(request, policy, ports);
    expect(outcome).toMatchObject({ state: 'parked', reason: 'sandbox-env' });
    expect(checkPhase).not.toHaveBeenCalled();
    const parked = log.mock.calls.find(([kind]) => kind === 'sandbox-env');
    expect(parked?.[1]).toContain(line);
  });

  it('a tests exit 1 without the marker still goes to rework as a tests FAIL', async () => {
    const worktree = await worktreeWithVerify();
    const log = vi.fn<Log>();
    const { ports, runBaseline } = checkPorts(log, worktree, { exitCode: 1, stdout: 'listen EPERM' });

    const outcome = await runIssue(request, policy, ports);

    expect(runBaseline).toHaveBeenCalled();
    expect(outcome).not.toMatchObject({ reason: 'sandbox-env' });
  });
});
