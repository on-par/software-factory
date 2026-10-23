import { join } from 'node:path';

import type { Octokit } from '@octokit/rest';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { eventTraitsFor } from '../events/kinds.js';
import { StubModelExecutor } from '../router/stub.js';
import { buildPhase as realBuild } from '../phases/build.js';
import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import type { BuildResult, buildPhase as realBuildPhase } from '../phases/build.js';
import type { CheckPhaseResult, checkPhase as realCheckPhase } from '../phases/check.js';
import type { PlanResult, planPhase as realPlanPhase } from '../phases/plan.js';
import type { shipPhase as realShipPhase } from '../phases/ship.js';
import { ProviderBreaker } from '../router/breaker.js';
import { createTempDirs } from '../harness/temp-dir.js';
import { ModelRouter } from '../router/index.js';
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
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const terminals = (log: ReturnType<typeof vi.fn<Log>>): string[] =>
  log.mock.calls.map((c) => c[0]).filter((t) => eventTraitsFor(t).isTerminal);

describe('runIssue logs exactly one terminal event (#3435)', () => {
  it('build escalation (real buildPhase) logs one escalate', async () => {
    const dir = tmp.makeSync('terminal-events-');
    try {
      const models: ModelsConfig = {
        ...MODELS,
        models: {
          w: {
            provider: 'custom',
            tier: 'worker',
            costPerMtokInput: 0,
            costPerMtokOutput: 0,
            contextWindow: 1000,
            capabilities: [],
            envKey: null,
          },
        },
        tiers: { worker: ['w'] },
      };
      const routes: RoutesConfig = { version: 1, routes: { build_claude: { tier: 'worker', description: 'stub' } } };
      const stub = new StubModelExecutor({ scripts: { build_claude: [{ output: 'ESCALATE: spec is ambiguous' }] } });
      const log = vi.fn<Log>();
      vi.mocked(planPhase).mockResolvedValue({ ...PLAN_OK, route: 'claude' });
      const p: RunPorts = {
        ...ports(log),
        router: new ModelRouter(models, routes, false, stub),
        workspace: { path: dir, dispose: async () => {} } as Workspace,
        buildPhase: realBuild,
      };
      const outcome = await runIssue(request, { ...policy, models, routes }, p);
      expect(outcome).toMatchObject({ state: 'escalated' });
      expect(terminals(log)).toEqual(['escalate']);
    } finally {
      await tmp.cleanup();
    }
  });

  it('a CHECK stuck run logs escalate with no earlier fail', async () => {
    vi.mocked(checkPhase).mockImplementation(async (opts) => {
      opts.log('fail', 'check stuck');
      return { ...CHECK_OK, passed: false, stuck: true, failureSignature: 's' };
    });
    const log = vi.fn<Log>();
    expect(await runIssue(request, policy, ports(log))).toMatchObject({ state: 'parked', reason: 'escalate' });
    expect(terminals(log)).toEqual(['escalate']);
  });

  it('a shipped run logs one ready', async () => {
    shipPhase.mockImplementation(async (opts) => {
      opts.log('ready', 'PR #9 ready');
      return { ok: true, prNumber: 9, ciOutcome: 'success' };
    });
    const log = vi.fn<Log>();
    expect(await runIssue(request, policy, ports(log))).toMatchObject({ state: 'ready' });
    expect(terminals(log)).toEqual(['ready']);
  });
});
