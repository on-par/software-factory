import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Octokit } from '@octokit/rest';
import { afterAll, describe, expect, it, vi } from 'vitest';

import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import type { ProviderOrder } from '../config/provider-order.js';
import { createTempDirs } from '../harness/temp-dir.js';
import type { BuildResult, buildPhase as realBuildPhase } from '../phases/build.js';
import type { CheckPhaseResult, checkPhase as realCheckPhase } from '../phases/check.js';
import type { PlanResult, planPhase as realPlanPhase } from '../phases/plan.js';
import type { ShipResult, shipPhase as realShipPhase } from '../phases/ship.js';
import { ProviderBreaker } from '../router/breaker.js';
import { ModelRouterError } from '../router/executor-error.js';
import { ModelRouter } from '../router/index.js';
import type { WorkRequest } from '../work/index.js';
import type { RunPolicy } from './policy.js';
import type { Workspace } from './ports.js';
import { runIssue, type RunPorts, type RunRequest } from './run-issue.js';

const WORK: WorkRequest = {
  id: 'github-issue:o/r#1',
  kind: 'github-issue',
  title: 'Fix the thing',
  brief: 'do the thing',
  acceptanceCriteria: [],
};

const ROUTES: RoutesConfig = {
  version: 1,
  routes: {
    plan: { tier: 'planners', description: 'stub' },
    build_claude: { tier: 'worker', description: 'stub', requires: 'claude' },
    build_codex: { tier: 'worker', description: 'stub', requires: 'codex' },
  },
};

const base = { costPerMtokInput: 0, costPerMtokOutput: 0, contextWindow: 1000, capabilities: [], envKey: null };
const claude = { ...base, provider: 'anthropic' as const, harness: 'claude-cli' };
const codex = { ...base, provider: 'openai' as const, harness: 'codex-cli', codex: true };
const opencodeGo = {
  ...base,
  provider: 'custom' as const,
  harness: 'opencode',
  providerModel: 'opencode-go/deepseek-v4-flash',
};

const MODELS: ModelsConfig = {
  version: 1,
  models: {
    'claude-boss': { ...claude, tier: 'planners' },
    'codex-boss': { ...codex, tier: 'planners' },
    'og-boss': { ...opencodeGo, tier: 'planners' },
    'claude-worker': { ...claude, tier: 'worker' },
    'codex-worker': { ...codex, tier: 'worker' },
    'og-worker': { ...opencodeGo, tier: 'worker' },
  },
  tiers: { planners: ['claude-boss', 'codex-boss', 'og-boss'], worker: ['claude-worker', 'codex-worker', 'og-worker'] },
  failover: { triggers: ['usage_cap'], maxRetries: 0, cooldownMs: 0 },
  routingRules: {},
};

const ORDER: ProviderOrder = {
  boss: ['claude-boss', 'codex-boss', 'og-boss'],
  worker: ['claude-worker', 'codex-worker', 'og-worker'],
  checker: ['claude-worker', 'codex-worker', 'og-worker'],
  triage: [],
};

const capError = (model: string) =>
  new ModelRouterError('cap', 'usage_cap', [{ model, reason: 'usage_cap', ok: false }]);

const tempDirs = createTempDirs();
const dir = tempDirs.makeSync('run-issue-provider-failover-');
afterAll(() => tempDirs.cleanup());
let counter = 0;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function makeRepo(): string {
  counter += 1;
  const repo = join(dir, `repo-${counter}`);
  execFileSync('git', ['init', '-q', repo]);
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'user.name', 'T');
  writeFileSync(join(repo, 'a.txt'), 'a');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'start');
  return repo;
}

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
  failover: { enabled: true, cooldownMs: 60_000, fallbackModel: 'claude-sonnet-5' },
  efficiency: { maxReworkRounds: 1, fastPath: false },
  processGroupGraceMs: 50,
  providerOrder: ORDER,
};

const policy: RunPolicy = {
  models: { version: 1, models: {}, tiers: {}, failover: request.failover as never, routingRules: {} } as never,
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

const CHECK_OK: CheckPhaseResult = {
  passed: true,
  summary: { failures: 0, passes: 1, skips: 0, total: 1, results: [] },
  reworkRounds: 0,
};

interface Setup {
  openProviders?: string[];
  workspace?: string;
  request?: Partial<RunRequest>;
  build?: (call: number, opts: Parameters<typeof realBuildPhase>[0]) => Promise<BuildResult>;
  check?: (call: number, skipDuringCall: () => ReadonlySet<string> | undefined) => Promise<CheckPhaseResult>;
}

async function run(setup: Setup = {}) {
  counter += 1;
  const breaker = new ProviderBreaker(join(dir, `breaker-${counter}.json`));
  for (const provider of setup.openProviders ?? []) await breaker.open(provider, 'usage_cap', 60 * 60_000);
  const events: Array<[string, string]> = [];
  const failovers: unknown[] = [];
  const router = new ModelRouter(MODELS, ROUTES);
  let stageSkip: ReadonlySet<string> | undefined;
  const skipCalls: Array<ReadonlySet<string> | undefined> = [];
  const original = router.setStageSkipProviders.bind(router);
  router.setStageSkipProviders = (providers) => {
    stageSkip = providers;
    skipCalls.push(providers);
    original(providers);
  };
  const planPhase = vi.fn<typeof realPlanPhase>(
    async (opts) =>
      ({
        ok: true,
        route: 'claude',
        specPath: '/tmp/wt/spec.md',
        model: opts.modelOverride ?? 'm',
        designArtifact: null,
      }) satisfies PlanResult,
  );
  let buildCalls = 0;
  const buildPhase = vi.fn<typeof realBuildPhase>(async (opts) => {
    buildCalls += 1;
    if (setup.build) return setup.build(buildCalls, opts);
    return { ok: true, model: opts.modelOverride ?? 'm', route: opts.route };
  });
  let checkCalls = 0;
  const checkPhase = vi.fn<typeof realCheckPhase>(async () => {
    checkCalls += 1;
    return setup.check ? setup.check(checkCalls, () => stageSkip) : CHECK_OK;
  });
  const ports: RunPorts = {
    router,
    octokit: {} as Octokit,
    workspace: { path: setup.workspace ?? makeRepo(), dispose: async () => {} } as Workspace,
    events: () => (type: string, msg: string, extra?: { providerFailover?: unknown }) => {
      events.push([type, msg]);
      if (type === 'provider_failover') failovers.push(extra?.providerFailover);
    },
    breaker,
    resolveConstitution: () => null,
    planPhase,
    buildPhase,
    checkPhase,
    shipPhase: vi.fn<typeof realShipPhase>().mockResolvedValue({ ok: true, prNumber: 42 } satisfies ShipResult),
  };
  const outcome = await runIssue({ ...request, ...setup.request }, policy, ports);
  return { outcome, events, failovers, planPhase, buildPhase, checkPhase, skipCalls, workspace: ports.workspace.path };
}

const types = (events: Array<[string, string]>) => events.map(([t]) => t);

describe('runIssue — provider failover at the phase boundary (#3338)', () => {
  it('a usage cap mid-BUILD reruns BUILD from its start on the next provider (2026-10-20)', async () => {
    const repo = makeRepo();
    const startSha = git(repo, 'rev-parse', 'HEAD');
    const seen: Array<{ head: string; partial: boolean; model?: string; route: string }> = [];
    const { outcome, failovers, buildPhase, events } = await run({
      workspace: repo,
      build: async (call, opts) => {
        seen.push({
          head: git(repo, 'rev-parse', 'HEAD'),
          partial: existsSync(join(repo, 'partial.ts')),
          model: opts.modelOverride,
          route: opts.route,
        });
        if (call === 1) {
          writeFileSync(join(repo, 'partial.ts'), 'half');
          git(repo, 'add', '.');
          git(repo, 'commit', '-q', '-m', 'partial');
          throw capError('claude-worker');
        }
        return { ok: true, model: opts.modelOverride ?? 'm', route: opts.route };
      },
    });
    expect(outcome.state).toBe('ready');
    expect(buildPhase).toHaveBeenCalledTimes(2);
    expect(seen[0]).toMatchObject({ model: 'claude-worker', route: 'claude', partial: false });
    expect(seen[1]).toEqual({ head: startSha, partial: false, model: 'codex-worker', route: 'codex' });
    expect(buildPhase.mock.calls.every(([o]) => o.crossProviderLadder === false)).toBe(true);
    expect(failovers).toEqual([{ stage: 'build', from: 'claude', to: 'codex', issue: 1 }]);
    expect(types(events).filter((t) => t === 'provider_failover')).toHaveLength(1);
  });

  it("a provider capped before PLAN runs PLAN on the next provider's boss model (#3338)", async () => {
    const { planPhase, failovers, outcome } = await run({ openProviders: ['anthropic'] });
    expect(outcome.state).toBe('ready');
    expect(planPhase).toHaveBeenCalledTimes(1);
    expect(planPhase.mock.calls[0]?.[0].modelOverride).toBe('codex-boss');
    expect(planPhase.mock.calls[0]?.[0].modelFallbacks).toBeUndefined();
    expect([...(planPhase.mock.calls[0]?.[0].skipProviders ?? [])]).toEqual(['anthropic']);
    expect(failovers).toEqual([]);
  });

  it('a non-cap BUILD failure parks with no rerun and no provider_failover (#3338)', async () => {
    const { outcome, buildPhase, failovers } = await run({
      build: async () => {
        throw new ModelRouterError('x', 'error', [{ model: 'claude-worker', reason: 'error', ok: false }]);
      },
    });
    expect(outcome.state).toBe('parked');
    expect(buildPhase).toHaveBeenCalledTimes(1);
    expect(failovers).toEqual([]);
  });

  it('a usage cap without a worktree snapshot is not rerun on a dirty tree (#3338)', async () => {
    const notARepo = join(dir, 'not-a-repo');
    execFileSync('mkdir', ['-p', notARepo]);
    const { buildPhase, failovers } = await run({
      workspace: notARepo,
      build: async () => {
        throw capError('claude-worker');
      },
    });
    expect(buildPhase).toHaveBeenCalledTimes(1);
    expect(failovers).toEqual([]);
  });

  it("a repo-pinned build route keeps today's BUILD path (ADR-0092, #3338)", async () => {
    const { buildPhase, outcome } = await run({ request: { preferredRoute: 'codex' } });
    expect(outcome.state).toBe('ready');
    expect(buildPhase.mock.calls[0]?.[0].crossProviderLadder).toBeUndefined();
    expect(buildPhase.mock.calls[0]?.[0].route).toBe('codex');
  });

  it("providerOrder unset keeps today's phase options (#3338)", async () => {
    const { planPhase, buildPhase, skipCalls, failovers } = await run({
      request: {
        providerOrder: undefined,
        modelPins: { sources: {}, plan: 'claude-boss', planFallback: 'codex-boss' },
      },
    });
    expect(planPhase.mock.calls[0]?.[0]).toMatchObject({
      modelOverride: 'claude-boss',
      modelFallbacks: ['codex-boss'],
      skipProviders: undefined,
    });
    expect(buildPhase.mock.calls[0]?.[0].crossProviderLadder).toBeUndefined();
    expect(buildPhase.mock.calls[0]?.[0].modelOverride).toBeUndefined();
    expect(skipCalls).toEqual([]);
    expect(failovers).toEqual([]);
  });

  it('a usage cap in CHECK reruns CHECK from its start on the next provider and clears the skip set (#3338)', async () => {
    const repo = makeRepo();
    const startSha = git(repo, 'rev-parse', 'HEAD');
    const heads: string[] = [];
    const skipsDuring: Array<ReadonlySet<string> | undefined> = [];
    const { outcome, failovers, checkPhase, skipCalls } = await run({
      workspace: repo,
      check: async (call, skip) => {
        heads.push(git(repo, 'rev-parse', 'HEAD'));
        skipsDuring.push(skip());
        if (call === 1) {
          writeFileSync(join(repo, 'partial.ts'), 'half');
          git(repo, 'add', '.');
          git(repo, 'commit', '-q', '-m', 'partial');
          throw capError('claude-worker');
        }
        return CHECK_OK;
      },
    });
    expect(outcome.state).toBe('ready');
    expect(checkPhase).toHaveBeenCalledTimes(2);
    expect(heads).toEqual([startSha, startSha]);
    expect(skipsDuring[0]?.size ?? 0).toBe(0);
    expect([...(skipsDuring[1] ?? [])]).toEqual(['anthropic']);
    expect(failovers).toEqual([{ stage: 'check', from: 'claude', to: 'codex', issue: 1 }]);
    expect(skipCalls.at(-1)).toBeUndefined();
  });
});
