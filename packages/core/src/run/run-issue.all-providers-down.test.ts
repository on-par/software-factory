import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
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

const tempDirs = createTempDirs();
const dir = tempDirs.makeSync('run-issue-all-providers-down-');
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

const HOUR = 60 * 60_000;
// The plan tier lacks opencode-go while the order lists it.
const NARROW_TIER: ModelsConfig = { ...MODELS, tiers: { ...MODELS.tiers, planners: ['claude-boss', 'codex-boss'] } };

async function run(open: (breaker: ProviderBreaker) => Promise<void>, models: ModelsConfig = MODELS) {
  counter += 1;
  const breaker = new ProviderBreaker(join(dir, `breaker-${counter}.json`), undefined, { fingerprint: () => 'fp' });
  await open(breaker);
  const events: Array<[string, string]> = [];
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
  const ports: RunPorts = {
    router: new ModelRouter(models, ROUTES),
    octokit: {} as Octokit,
    workspace: { path: makeRepo(), dispose: async () => {} } as Workspace,
    events: () => (type: string, msg: string) => {
      events.push([type, msg]);
    },
    breaker,
    resolveConstitution: () => null,
    planPhase,
    buildPhase: vi.fn<typeof realBuildPhase>(async (opts) => ({ ok: true, model: 'm', route: opts.route })),
    checkPhase: vi.fn<typeof realCheckPhase>(async () => CHECK_OK),
    shipPhase: vi.fn<typeof realShipPhase>().mockResolvedValue({ ok: true, prNumber: 42 } satisfies ShipResult),
  };
  const outcome = await runIssue({ ...request, failover: { ...request.failover, enabled: false } }, policy, ports);
  return { outcome, events, planPhase };
}

describe('runIssue — all_providers_down release under providerOrder (#3340)', () => {
  it('claude, codex and opencode-go capped releases provider-cap with all_capped at the earliest reset', async () => {
    const { outcome, planPhase } = await run(async (b) => {
      await b.open('anthropic', 'usage_cap', 2 * HOUR);
      await b.open('openai', 'usage_cap', 4 * HOUR);
      await b.open('custom', 'usage_cap', 6 * HOUR);
    });
    expect(planPhase).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ state: 'released', reason: 'provider-cap' });
    if (outcome.state !== 'released' || outcome.reason !== 'provider-cap') throw new Error('unreachable');
    expect(outcome.allProvidersDown).toMatchObject({
      stage: 'plan',
      detail: 'all_capped',
      nextAvailableAt: outcome.resetAt,
      issue: 1,
    });
    expect(outcome.allProvidersDown?.providers.map((p) => p.provider)).toEqual(['anthropic', 'openai', 'custom']);
  });

  it('claude capped and codex/opencode-go auth-open releases provider-cap with reset_pending at the claude reset', async () => {
    const { outcome, planPhase } = await run(async (b) => {
      await b.open('anthropic', 'usage_cap', 2 * HOUR);
      await b.openUntilCredentialsChange('openai', 'local_auth');
      await b.openUntilCredentialsChange('custom', 'local_auth');
    });
    expect(planPhase).not.toHaveBeenCalled();
    expect(outcome.state).toBe('released');
    if (outcome.state !== 'released' || outcome.reason !== 'provider-cap') throw new Error('unreachable');
    expect(outcome.allProvidersDown).toMatchObject({ detail: 'reset_pending', nextAvailableAt: outcome.resetAt });
  });

  it('with providerOrder, claude and codex capped runs PLAN on opencode-go even when the plan tier lacks it', async () => {
    const { outcome, planPhase, events } = await run(async (b) => {
      await b.open('anthropic', 'usage_cap', HOUR);
      await b.open('openai', 'usage_cap', HOUR);
    }, NARROW_TIER);
    expect(outcome.state).not.toBe('released');
    expect(planPhase).toHaveBeenCalledTimes(1);
    expect(planPhase.mock.calls[0]?.[0].modelOverride).toBe('og-boss');
    expect(events.some(([t]) => t === 'all_providers_down')).toBe(false);
  });
});
