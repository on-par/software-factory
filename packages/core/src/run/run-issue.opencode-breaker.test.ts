import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Octokit } from '@octokit/rest';
import { afterAll, describe, expect, it, vi } from 'vitest';

import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import type { BuildResult, buildPhase as realBuildPhase } from '../phases/build.js';
import type { CheckPhaseResult, checkPhase as realCheckPhase } from '../phases/check.js';
import type { PlanResult, planPhase as realPlanPhase } from '../phases/plan.js';
import type { ShipResult, shipPhase as realShipPhase } from '../phases/ship.js';
import { ProviderBreaker } from '../router/breaker.js';
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
    build_claude: { tier: 'worker', description: 'stub', requires: 'claude' },
    build_codex: { tier: 'worker', description: 'stub', requires: 'codex' },
    build_opencode: { tier: 'worker', description: 'stub', requires: 'opencode' },
  },
};

type ModelDef = { provider: string; codex?: boolean; harness?: string };

const OC: ModelDef = { provider: 'opencode-go', harness: 'opencode' };
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

const breakerDir = mkdtempSync(join(tmpdir(), 'run-issue-oc-breaker-'));
afterAll(() => rmSync(breakerDir, { recursive: true, force: true }));
let counter = 0;

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

async function run(opts: { open: boolean; models?: Record<string, ModelDef>; request?: Partial<RunRequest> }) {
  counter += 1;
  const breaker = new ProviderBreaker(join(breakerDir, `breaker-oc-${counter}.json`));
  if (opts.open) await breaker.open('opencode-go', 'usage_cap', 30 * 60_000);
  const events: Array<[string, string]> = [];
  const buildPhase = vi
    .fn<typeof realBuildPhase>()
    .mockResolvedValue({ ok: true, model: 'm', route: 'opencode' } satisfies BuildResult);
  const ports: RunPorts = {
    router: routerWith(opts.models ?? { 'oc-build': OC, 'claude-build': CLAUDE }),
    octokit: {} as Octokit,
    workspace: { path: '/tmp/wt', dispose: async () => {} } as Workspace,
    events: () => (type: string, msg: string) => events.push([type, msg]),
    breaker,
    resolveConstitution: () => null,
    planPhase: vi.fn<typeof realPlanPhase>().mockResolvedValue({
      ok: true,
      route: 'opencode',
      specPath: '/tmp/wt/spec.md',
      model: 'm',
      designArtifact: null,
    } satisfies PlanResult),
    buildPhase,
    checkPhase: vi.fn<typeof realCheckPhase>().mockResolvedValue({
      passed: true,
      summary: { failures: 0, passes: 1, skips: 0, total: 1, results: [] },
      reworkRounds: 0,
    } satisfies CheckPhaseResult),
    shipPhase: vi.fn<typeof realShipPhase>().mockResolvedValue({ ok: true, prNumber: 42 } satisfies ShipResult),
  };
  const outcome = await runIssue({ ...request, ...opts.request }, policy, ports);
  return { events, outcome, buildPhase, call: buildPhase.mock.calls[0]?.[0] };
}

describe('runIssue — opencode provider breaker before BUILD (#2891)', () => {
  it('starts BUILD on claude and logs provider_breaker_skip when the opencode provider breaker is open', async () => {
    const { events, call } = await run({ open: true });
    expect(call).toMatchObject({ route: 'claude', modelOverride: 'claude-build' });
    const skip = events.find(([t]) => t === 'provider_breaker_skip');
    expect(skip?.[1]).toContain('opencode-go');
    expect(skip?.[1]).toMatch(/\d+m remaining/);
  });

  it('starts BUILD on claude and records the swap reason as a worker_failover when the opencode provider breaker is open', async () => {
    const { events, call } = await run({ open: true });
    expect(call).toMatchObject({ route: 'claude' });
    const failover = events.find(([t]) => t === 'worker_failover');
    expect(failover?.[1]).toContain('reason=usage_cap');
    expect(failover?.[1]).toContain('to_route=build_claude');
  });

  it('keeps the opencode route when the opencode provider breaker is closed', async () => {
    const { events, call } = await run({ open: false });
    expect(call).toMatchObject({ route: 'opencode' });
    expect(events.some(([t]) => t === 'provider_breaker_skip')).toBe(false);
  });

  it("fails BUILD with the cap reason and reset time without calling buildPhase when the pinned opencode route's breaker is open", async () => {
    const { events, outcome, buildPhase } = await run({ open: true, request: { preferredRoute: 'opencode' } });
    expect(buildPhase).not.toHaveBeenCalled();
    expect(outcome.state).toBe('escalated');
    const reason = (outcome as { reason?: string }).reason ?? '';
    expect(reason).toMatch(/usage_cap/);
    expect(reason).toMatch(/ADR-0092/);
    expect(reason).toMatch(/resets at \d{4}-\d{2}-\d{2}T/);
    expect(events.find(([t]) => t === 'provider_breaker_pinned')?.[1]).toContain('opencode-go');
    expect(events.some(([t]) => t === 'provider_breaker_skip')).toBe(false);
  });

  it('falls back to codex when no claude worker exists', async () => {
    const { call } = await run({
      open: true,
      models: { 'oc-build': OC, 'gpt-build': { provider: 'openai', codex: true } },
    });
    expect(call).toMatchObject({ route: 'codex', modelOverride: 'gpt-build' });
  });

  it('does not consult the opencode breaker when failover is disabled', async () => {
    const { events, call } = await run({
      open: true,
      request: { failover: { enabled: false, cooldownMs: 60_000, fallbackModel: 'claude-sonnet-5' } },
    });
    expect(call).toMatchObject({ route: 'opencode' });
    expect(events.some(([t]) => t.startsWith('provider_breaker'))).toBe(false);
  });
});
