import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Octokit } from '@octokit/rest';
import { afterAll, describe, expect, it, vi } from 'vitest';

import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import type { BuildResult, buildPhase as realBuildPhase } from '../phases/build.js';
import type { CheckPhaseResult, checkPhase as realCheckPhase } from '../phases/check.js';
import type { PlanResult, planPhase as realPlanPhase } from '../phases/plan.js';
import type { ShipResult, shipPhase as realShipPhase } from '../phases/ship.js';
import { createTempDirs } from '../harness/temp-dir.js';
import { ProviderBreaker } from '../router/breaker.js';
import { ModelRouter } from '../router/index.js';
import { scoreSpec } from '../eval/score.js';
import { parseSpec, writeSpec } from '../spec/index.js';
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
    build_claude: { tier: 'worker', description: 'stub', requires: 'claude' },
    build_codex: { tier: 'worker', description: 'stub', requires: 'codex' },
    build_opencode: { tier: 'worker', description: 'stub', requires: 'opencode' },
  },
};

type ModelDef = { provider: string; codex?: boolean; harness?: string };

const CLAUDE: ModelDef = { provider: 'anthropic' };

function routerWith(defs: Record<string, ModelDef>): ModelRouter {
  const models: ModelsConfig = {
    version: 1,
    models: Object.fromEntries(
      Object.entries(defs).map(([id, def]) => [
        id,
        {
          provider: def.provider as ModelsConfig['models'][string]['provider'],
          tier: 'worker',
          costPerMtokInput: 0,
          costPerMtokOutput: 0,
          contextWindow: 1000,
          capabilities: [],
          envKey: null,
          ...(def.codex ? { codex: true } : {}),
          ...(def.harness ? { harness: def.harness } : {}),
        },
      ]),
    ),
    tiers: { worker: Object.keys(defs) },
    failover: { triggers: [], maxRetries: 0, cooldownMs: 0 },
    routingRules: {},
  };
  return new ModelRouter(models, ROUTES);
}

const CODEX: ModelDef = { provider: 'openai', codex: true };

const tempDirs = createTempDirs();
const dir = tempDirs.makeSync('run-issue-route-degraded-');
afterAll(() => tempDirs.cleanup());
let counter = 0;
const specPath = (n: number) => join(dir, `spec-${n}.md`);

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

async function run(opts: { openDuringPlan: boolean }) {
  counter += 1;
  const spec = specPath(counter);
  const breaker = new ProviderBreaker(join(dir, `breaker-${counter}.json`));
  const events: Array<[string, string]> = [];
  let specAtBuild: string | undefined;
  const planPhase = vi.fn<typeof realPlanPhase>().mockImplementation(async () => {
    await writeSpec(spec, { body: '# Spec\n', data: { route: 'codex' } });
    if (opts.openDuringPlan) await breaker.open('openai', 'usage_cap', 30 * 60_000);
    return { ok: true, route: 'codex', specPath: spec, model: 'm', designArtifact: null } satisfies PlanResult;
  });
  const buildPhase = vi.fn<typeof realBuildPhase>().mockImplementation(async (o) => {
    specAtBuild = readFileSync(spec, 'utf8');
    return { ok: true, model: 'm', route: o.route } satisfies BuildResult;
  });
  const ports: RunPorts = {
    router: routerWith({ 'codex-build': CODEX, 'claude-build': CLAUDE }),
    octokit: {} as Octokit,
    workspace: { path: '/tmp/wt', dispose: async () => {} } as Workspace,
    events: () => (type: string, msg: string) => events.push([type, msg]),
    breaker,
    resolveConstitution: () => null,
    planPhase,
    buildPhase,
    checkPhase: vi.fn<typeof realCheckPhase>().mockResolvedValue({
      passed: true,
      summary: { failures: 0, passes: 1, skips: 0, total: 1, results: [] },
      reworkRounds: 0,
    } satisfies CheckPhaseResult),
    shipPhase: vi.fn<typeof realShipPhase>().mockResolvedValue({ ok: true, prNumber: 42 } satisfies ShipResult),
  };
  await runIssue({ ...request, specPath: spec }, policy, ports);
  return { events, planPhase, buildPhase, spec, specAtBuild, call: buildPhase.mock.calls[0]?.[0] };
}

describe('runIssue — route stays truthful when the codex breaker opens mid-lane (#664)', () => {
  it('passes the same RouteCapabilities to planPhase and buildPhase when the breaker state does not change', async () => {
    const { planPhase, call, events } = await run({ openDuringPlan: false });
    expect(call?.route).toBe('codex');
    expect(call?.routeCapabilities).toBe(planPhase.mock.calls[0]?.[0].routeCapabilities);
    expect(events.filter(([t]) => t === 'route-degraded')).toHaveLength(0);
  });

  it('breaker opening after PLAN rewrites the spec route to claude and logs route-degraded', async () => {
    const { events, call, specAtBuild } = await run({ openDuringPlan: true });
    expect(specAtBuild).toContain('route: claude');
    expect(events.filter(([t]) => t === 'route-degraded')).toHaveLength(1);
    expect(call?.route).toBe('claude');
    expect(call?.routeCapabilities?.codexBreakerOpen).toBe(true);
  });

  it('after a mid-lane breaker open, the spec route equals build.route', async () => {
    const { spec, call } = await run({ openDuringPlan: true });
    expect(parseSpec(readFileSync(spec, 'utf8')).route).toBe(call?.route);
  });

  it('scoreSpec on the post-BUILD spec reports the route that built the issue', async () => {
    const { spec } = await run({ openDuringPlan: true });
    expect(scoreSpec(readFileSync(spec, 'utf8'), '', 'claude').route).toBe('claude');
  });
});
