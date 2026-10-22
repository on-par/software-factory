import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Octokit } from '@octokit/rest';
import { afterAll, describe, expect, it, vi } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';
import { ModelRegistry } from '../models/index.js';
import type { BuildResult, buildPhase as realBuildPhase } from '../phases/build.js';
import type { CheckPhaseResult, checkPhase as realCheckPhase } from '../phases/check.js';
import type { planPhase as realPlanPhase } from '../phases/plan.js';
import { settlePlanRoute } from '../phases/plan-route.js';
import type { ShipResult, shipPhase as realShipPhase } from '../phases/ship.js';
import { ProviderBreaker } from '../router/breaker.js';
import { ModelRouter } from '../router/index.js';
import { StubModelExecutor } from '../router/stub.js';
import type { RunPolicy } from '../run/policy.js';
import type { Workspace } from '../run/ports.js';
import { runIssue, type RunPorts, type RunRequest } from '../run/run-issue.js';
import type { WorkRequest } from '../work/index.js';
import type { ModelsConfig, RoutesConfig } from './index.js';
import { type BuildRoutePin, decideBuildRoute, describeEffectiveConfig } from './repo.js';

function baseModel(overrides: Partial<ModelsConfig['models'][string]> = {}): ModelsConfig['models'][string] {
  return {
    provider: 'anthropic',
    tier: 'worker',
    costPerMtokInput: 0,
    costPerMtokOutput: 0,
    contextWindow: 1000,
    capabilities: [],
    envKey: null,
    ...overrides,
  };
}

const models: ModelsConfig = {
  version: 1,
  models: {
    'claude-model': baseModel({ tier: 'boss' }),
    'gpt-model-a': baseModel({ provider: 'openai', codex: true }),
    'ollama-model': baseModel({ provider: 'ollama' }),
  },
  tiers: { boss: ['claude-model'], worker: ['gpt-model-a', 'ollama-model'] },
  failover: { triggers: [], maxRetries: 0, cooldownMs: 0, escalateAfterTierExhausted: false },
  routingRules: {},
};

const routes: RoutesConfig = {
  version: 1,
  routes: {
    plan: { tier: 'boss', description: 'stub' },
    build_claude: { tier: 'worker', description: 'stub', requires: 'claude' },
    build_codex: { tier: 'worker', description: 'stub', requires: 'codex' },
  },
};

const registry = new ModelRegistry(models);

describe('decideBuildRoute table over repo route x build pin x localOnly x codexDisabled', () => {
  type Row = {
    name: string;
    repoRoute?: BuildRoutePin;
    buildPin?: string;
    localOnly?: boolean;
    codexDisabled?: boolean;
    route?: BuildRoutePin;
    source: 'repo' | 'local-only' | 'build-pin' | 'plan';
    note?: RegExp;
  };
  const rows: Row[] = [
    { name: 'no pin, no flags', source: 'plan' },
    { name: 'unknown pin', buildPin: 'no-such-model', source: 'plan' },
    { name: 'routeless pin', buildPin: 'ollama-model', source: 'plan' },
    { name: 'claude pin', buildPin: 'claude-model', route: 'claude', source: 'build-pin' },
    { name: 'codex pin', buildPin: 'gpt-model-a', route: 'codex', source: 'build-pin' },
    {
      name: 'codex pin, codex disabled',
      buildPin: 'gpt-model-a',
      codexDisabled: true,
      source: 'plan',
      note: /codex is disabled/,
    },
    {
      name: 'claude pin, codex disabled',
      buildPin: 'claude-model',
      codexDisabled: true,
      route: 'claude',
      source: 'build-pin',
    },
    { name: 'local-only, claude pin', buildPin: 'claude-model', localOnly: true, route: 'codex', source: 'local-only' },
    { name: 'local-only, no pin', localOnly: true, route: 'codex', source: 'local-only' },
    {
      name: 'local-only, codex disabled',
      localOnly: true,
      codexDisabled: true,
      route: 'claude',
      source: 'local-only',
      note: /falls back to claude/,
    },
    {
      name: 'repo route beats pin',
      repoRoute: 'opencode',
      buildPin: 'claude-model',
      route: 'opencode',
      source: 'repo',
    },
    { name: 'repo route beats local-only', repoRoute: 'claude', localOnly: true, route: 'claude', source: 'repo' },
    {
      name: 'repo route beats codex-disabled',
      repoRoute: 'codex',
      buildPin: 'gpt-model-a',
      codexDisabled: true,
      route: 'codex',
      source: 'repo',
    },
  ];

  it.each(rows)('$name', ({ repoRoute, buildPin, localOnly, codexDisabled, route, source, note }) => {
    const got = decideBuildRoute(registry, { repoRoute, buildPin, localOnly, codexDisabled });
    expect(got.route).toBe(route);
    expect(got.source).toBe(source);
    if (note) expect(got.note).toMatch(note);
    else expect(got.note).toBeUndefined();
  });
});

const WORK: WorkRequest = {
  id: 'github-issue:o/r#1',
  kind: 'github-issue',
  title: 'Fix the thing',
  brief: 'do the thing',
  acceptanceCriteria: [],
};

const tempDirs = createTempDirs();
const dir = tempDirs.makeSync('build-route-');
afterAll(() => tempDirs.cleanup());

/** Runs runIssue with a PLAN stub that settles the route through the real settlePlanRoute and returns the
 *  route BUILD receives. */
async function runBuildRoute(pin: string, flags: { localOnly?: boolean; codexDisabled: boolean }): Promise<string> {
  const specPath = join(dir, 'spec.md');
  writeFileSync(specPath, '---\nroute: claude\n---\n# Spec\n');
  const request: RunRequest = {
    issue: 1,
    repo: 'o/r',
    branch: 'issue-1-fix-the-thing',
    specPath,
    work: WORK,
    startedAt: '2026-01-01T00:00:00.000Z',
    options: { interactive: false, autoRework: true, approvePlan: false, sandboxDisabled: false },
    timeouts: { plan: 60, build: 60, check: 60, approval: 60, tests: 60 },
    modelPins: { build: pin, sources: { build: 'env' } },
    codexDisabled: flags.codexDisabled,
    localOnly: flags.localOnly,
    skipCI: false,
    failover: { enabled: false, cooldownMs: 60_000, fallbackModel: 'claude-model' },
    efficiency: { maxReworkRounds: 1, fastPath: false },
    processGroupGraceMs: 50,
  };
  const policy: RunPolicy = {
    models,
    routes,
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
  const planPhase = vi.fn<typeof realPlanPhase>().mockImplementation(async (opts) => {
    const route = await settlePlanRoute({
      parsedRoute: 'claude',
      runnableNow: ['claude', 'codex'],
      localOnly: opts.localOnly,
      isCodexDisabled: opts.codexDisabled ?? false,
      preferredRoute: opts.preferredRoute,
      specPath,
      log: () => {},
    });
    return { ok: true, route, specPath, model: 'm', designArtifact: null };
  });
  const buildPhase = vi
    .fn<typeof realBuildPhase>()
    .mockResolvedValue({ ok: true, model: 'm', route: 'claude' } satisfies BuildResult);
  const checkPhase = vi.fn<typeof realCheckPhase>().mockResolvedValue({
    passed: true,
    summary: { failures: 0, passes: 1, skips: 0, total: 1, results: [] },
    reworkRounds: 0,
  } satisfies CheckPhaseResult);
  const shipPhase = vi.fn<typeof realShipPhase>().mockResolvedValue({ ok: true, prNumber: 42 } satisfies ShipResult);
  const ports: RunPorts = {
    router: new ModelRouter(models, routes),
    octokit: {} as Octokit,
    workspace: { path: dir, dispose: async () => {} } as Workspace,
    events: () => () => {},
    breaker: new ProviderBreaker(join(dir, 'breaker.json')),
    resolveConstitution: () => null,
    planPhase,
    buildPhase,
    checkPhase,
    shipPhase,
  };
  await runIssue(request, policy, ports);
  return buildPhase.mock.calls[0][0].route as string;
}

function statusLine(env: NodeJS.ProcessEnv): string {
  const router = new ModelRouter(models, routes, false, new StubModelExecutor({ scripts: {} }));
  const line = describeEffectiveConfig({ router, repo: null, env, repoConfigPath: '.factory/config.json' }).find((l) =>
    l.startsWith('Build route:'),
  );
  return line ?? '';
}

describe('status and runIssue agree on the build route', () => {
  it('status and runIssue agree when a codex build pin meets FACTORY_CODEX=0', async () => {
    const line = statusLine({ FACTORY_BUILD_MODEL: 'gpt-model-a', FACTORY_CODEX: '0' });
    const route = await runBuildRoute('gpt-model-a', { codexDisabled: true });
    expect(line).toContain('plan decides');
    expect(line).not.toContain('derived from build pin');
    expect(route).not.toBe('codex');
  });

  it('status and runIssue agree on the forced codex route under FACTORY_LOCAL_ONLY=1', async () => {
    const line = statusLine({ FACTORY_BUILD_MODEL: 'claude-model', FACTORY_LOCAL_ONLY: '1' });
    const route = await runBuildRoute('claude-model', { localOnly: true, codexDisabled: false });
    expect(route).toBe('codex');
    expect(line).toBe('Build route: codex (local-only)');
  });
});
