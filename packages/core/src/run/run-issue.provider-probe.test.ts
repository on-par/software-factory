import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Octokit } from '@octokit/rest';
import { afterAll, describe, expect, it, vi } from 'vitest';

import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import type { ProviderOrder } from '../config/provider-order.js';
import { createTempDirs } from '../harness/temp-dir.js';
import type { buildPhase as realBuildPhase } from '../phases/build.js';
import type { CheckPhaseResult, checkPhase as realCheckPhase } from '../phases/check.js';
import type { PlanResult, planPhase as realPlanPhase } from '../phases/plan.js';
import type { ShipResult, shipPhase as realShipPhase } from '../phases/ship.js';
import type { ProviderRestoredPayload } from '../events/payloads.js';
import { ProviderBreaker } from '../router/breaker.js';
import { ModelRouterError } from '../router/executor-error.js';
import { ModelRouter } from '../router/index.js';
import type { WorkRequest } from '../work/index.js';
import type { RunPolicy } from './policy.js';
import type { Workspace } from './ports.js';
import type { ProviderProbe } from './provider-probe.js';
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
  triage: ['claude-worker', 'codex-worker', 'og-worker'],
};

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

const CAPPED_UNTIL = '2026-10-20T12:00:00.000Z'; // 07:00 CT
const T_0630 = Date.parse('2026-10-20T11:30:00Z');
const T_0705 = Date.parse('2026-10-20T12:05:00Z');

interface Setup {
  startAt?: number;
  probe: ProviderProbe;
}

async function run(setup: Setup) {
  counter += 1;
  let t = setup.startAt ?? T_0630;
  const restored: ProviderRestoredPayload[] = [];
  const file = join(dir, `breaker-${counter}.json`);
  const breaker = new ProviderBreaker(file, () => t, { onClose: (r) => restored.push(r) });
  await breaker.open('anthropic', 'usage_cap', 30 * 60_000, { cappedUntil: CAPPED_UNTIL });
  const events: Array<[string, string]> = [];
  const router = new ModelRouter(MODELS, ROUTES);
  let stageSkip: ReadonlySet<string> | undefined;
  const original = router.setStageSkipProviders.bind(router);
  router.setStageSkipProviders = (providers) => {
    stageSkip = providers;
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
  const buildPhase = vi.fn<typeof realBuildPhase>(async (opts) => {
    t = T_0705; // BUILD runs past the cap's reset
    return { ok: true, model: opts.modelOverride ?? 'm', route: opts.route };
  });
  let checkSkip: ReadonlySet<string> | undefined;
  const checkPhase = vi.fn<typeof realCheckPhase>(async () => {
    checkSkip = stageSkip;
    return CHECK_OK;
  });
  const probeProvider = vi.fn<ProviderProbe>(setup.probe);
  const ports: RunPorts = {
    router,
    octokit: {} as Octokit,
    workspace: { path: makeRepo(), dispose: async () => {} } as Workspace,
    events: () => (type: string, msg: string) => {
      events.push([type, msg]);
    },
    breaker,
    probeProvider,
    resolveConstitution: () => null,
    planPhase,
    buildPhase,
    checkPhase,
    shipPhase: vi.fn<typeof realShipPhase>().mockResolvedValue({ ok: true, prNumber: 42 } satisfies ShipResult),
  };
  const outcome = await runIssue(request, policy, ports);
  const entry = (JSON.parse(readFileSync(file, 'utf8')) as { providers: Record<string, { cappedUntil?: string }> })
    .providers.anthropic;
  return {
    outcome,
    events,
    restored,
    probeProvider,
    planPhase,
    buildPhase,
    breaker,
    entry,
    checkSkip: () => checkSkip,
  };
}

describe('runIssue — restore probe at the phase boundary (#3339)', () => {
  it('a capped preferred provider is probed after its reset and the next phase goes back to it (2026-10-20)', async () => {
    const r = await run({ probe: async () => {} });
    expect(r.outcome.state).toBe('ready');
    expect(r.buildPhase.mock.calls[0]?.[0].route).toBe('codex');
    expect(r.probeProvider).toHaveBeenCalledTimes(1);
    expect(r.probeProvider).toHaveBeenCalledWith('claude-worker');
    expect(r.restored).toEqual([{ provider: 'anthropic', at: '2026-10-20T12:05:00.000Z', cause: 'probe' }]);
    expect(r.checkSkip()?.has('anthropic') ?? false).toBe(false);
    expect((await r.breaker.status('anthropic')).open).toBe(false);
  });

  it('a probe that hits usage_cap with no reset keeps CHECK on codex and re-caps claude until 08:05 CT with no provider_capped', async () => {
    const r = await run({
      probe: async () => {
        throw new ModelRouterError('cap', 'usage_cap', [{ model: 'claude-worker', reason: 'usage_cap', ok: false }]);
      },
    });
    expect(r.outcome.state).toBe('ready');
    expect(r.probeProvider).toHaveBeenCalledTimes(1);
    expect(r.checkSkip()?.has('anthropic')).toBe(true);
    expect(r.entry?.cappedUntil).toBe('2026-10-20T13:05:00.000Z');
    expect(r.events.map(([type]) => type)).not.toContain('provider_capped');
    expect(r.restored).toEqual([]);
  });

  it('a probe that fails for another reason keeps claude capped and logs it', async () => {
    const r = await run({
      probe: async () => {
        throw new ModelRouterError('slow', 'timeout', [{ model: 'claude-worker', reason: 'timeout', ok: false }]);
      },
    });
    expect(r.outcome.state).toBe('ready');
    expect(r.events.some(([type, msg]) => type === 'router' && msg.includes('restore probe failed'))).toBe(true);
    expect(r.checkSkip()?.has('anthropic')).toBe(true);
    expect((await r.breaker.status('anthropic')).open).toBe(true);
  });

  it("PLAN's boundary probes before the cap gate", async () => {
    const r = await run({ startAt: T_0705, probe: async () => {} });
    expect(r.probeProvider).toHaveBeenCalledTimes(1);
    expect(r.planPhase.mock.calls[0]?.[0].modelOverride).toBe('claude-boss');
    expect(r.restored.map((x) => x.cause)).toEqual(['probe']);
  });
});
