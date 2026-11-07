import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Octokit } from '@octokit/rest';
import { afterAll, describe, expect, it, vi } from 'vitest';

import type { ModelsConfig, RoutesConfig } from '../config/index.js';
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
    build_command: { tier: 'worker', description: 'stub', requires: 'command' },
  },
};

const MODELS: ModelsConfig = {
  version: 1,
  models: {
    'my-model': {
      provider: 'custom',
      tier: 'worker',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
      harness: 'my-agent',
    },
  },
  tiers: { worker: ['my-model'] },
  failover: { triggers: [], maxRetries: 0, cooldownMs: 0 },
  routingRules: {},
  harnesses: {
    'my-agent': { command: 'my-agent {model}', prompt: 'stdin', output: 'stdout', agentic: true, usage: 'none' },
  },
};

const breakerDir = mkdtempSync(join(tmpdir(), 'run-issue-base-health-'));
afterAll(() => rmSync(breakerDir, { recursive: true, force: true }));

const request: RunRequest = {
  issue: 1,
  repo: 'o/r',
  branch: 'issue-1-fix-the-thing',
  specPath: '/tmp/wt/spec.md',
  work: WORK,
  startedAt: '2026-01-01T00:00:00.000Z',
  options: { interactive: false, autoRework: true, approvePlan: false, sandboxDisabled: false },
  timeouts: { plan: 60, build: 60, check: 60, approval: 60, tests: 600, compile: 900 },
  modelPins: { build: 'my-model', sources: { build: 'repo' } },
  codexDisabled: false,
  skipCI: false,
  failover: { enabled: false, cooldownMs: 60_000, fallbackModel: 'claude-sonnet-5' },
  efficiency: { maxReworkRounds: 1, fastPath: false },
  processGroupGraceMs: 50,
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

describe('runIssue — pre-PLAN base health tests timeout (#3095)', () => {
  it('forwards request.timeouts.tests to the base health port as testsTimeoutSeconds', async () => {
    const checkBaseHealth = vi.fn<NonNullable<RunPorts['checkBaseHealth']>>().mockResolvedValue({
      kind: 'red',
      baseSha: 'a'.repeat(40),
      failingChecks: ['tests'],
      cached: false,
    });
    const ports: RunPorts = {
      router: new ModelRouter(MODELS, ROUTES),
      octokit: {} as Octokit,
      workspace: { path: '/tmp/wt', dispose: async () => {} } as Workspace,
      events: () => () => {},
      breaker: new ProviderBreaker(join(breakerDir, 'breaker.json')),
      resolveConstitution: () => null,
      checkBaseHealth,
    };
    await runIssue(request, policy, ports);
    expect(checkBaseHealth.mock.calls[0][0]).toMatchObject({
      timeoutSeconds: 60,
      testsTimeoutSeconds: 600,
      compileTimeoutSeconds: 900,
    });
  });

  it('passes check.baselineCacheTtlHours to the port as cacheTtlHours (#3540)', async () => {
    const checkBaseHealth = vi.fn<NonNullable<RunPorts['checkBaseHealth']>>().mockResolvedValue({
      kind: 'red',
      baseSha: 'a'.repeat(40),
      failingChecks: ['tests'],
      cached: false,
    });
    const ports: RunPorts = {
      router: new ModelRouter(MODELS, ROUTES),
      octokit: {} as Octokit,
      workspace: { path: '/tmp/wt', dispose: async () => {} } as Workspace,
      events: () => () => {},
      breaker: new ProviderBreaker(join(breakerDir, 'breaker.json')),
      resolveConstitution: () => null,
      checkBaseHealth,
    };
    await runIssue({ ...request, baselineCacheTtlHours: 6 }, policy, ports);
    expect(checkBaseHealth.mock.calls[0][0]).toMatchObject({ cacheTtlHours: 6 });
  });
});

describe('runIssue — pre-PLAN base health evidence', () => {
  const BASE = 'c'.repeat(40);
  const portsWith = (result: Awaited<ReturnType<NonNullable<RunPorts['checkBaseHealth']>>>) => {
    const log = vi.fn<(type: string, msg: string) => void>();
    const router = new ModelRouter(MODELS, ROUTES);
    const ports: RunPorts = {
      router,
      octokit: {} as Octokit,
      workspace: { path: '/tmp/wt', dispose: async () => {} } as Workspace,
      events: () => log,
      breaker: new ProviderBreaker(join(breakerDir, 'breaker.json')),
      resolveConstitution: () => null,
      checkBaseHealth: vi.fn<NonNullable<RunPorts['checkBaseHealth']>>().mockResolvedValue(result),
    };
    return { ports, log, routerRun: vi.spyOn(router, 'run') };
  };
  const released = (log: ReturnType<typeof vi.fn>) =>
    log.mock.calls.filter((c) => c[0] === 'environment-released').map((c) => String(c[1]));

  it('an inconclusive base is held before PLAN, never reported as failing tests, with the evidence in the message', async () => {
    const evidence = [
      {
        checker: 'tests',
        cause: 'timeout' as const,
        command: 'bash scripts/verify.sh --no-e2e',
        timeoutSeconds: 300,
        tail: 'timed out after 300s (raise timeouts.tests_seconds or FACTORY_TESTS_TIMEOUT)',
      },
    ];
    const { ports, log, routerRun } = portsWith({
      kind: 'inconclusive',
      baseSha: BASE,
      failingChecks: [],
      cached: false,
      evidence,
    });
    const outcome = await runIssue(request, policy, ports);
    expect(outcome).toMatchObject({ state: 'released', reason: 'environment', baseSha: BASE, failingChecks: [] });
    expect(outcome).toMatchObject({ baseEvidence: evidence });
    expect(outcome).toMatchObject({ baseInconclusive: true });
    expect(routerRun).not.toHaveBeenCalled();
    const [msg] = released(log);
    expect(msg).toBeDefined();
    expect(msg).not.toMatch(/fails tests/);
    expect(msg).toContain('could not run');
    expect(msg).toContain('tests: timeout after 300s');
    expect(msg).toContain('bash scripts/verify.sh --no-e2e');
    expect(msg).toContain('timed out after 300s');
  });

  it('a red base keeps releasing and now names the failing evidence', async () => {
    const { ports, log } = portsWith({
      kind: 'red',
      baseSha: BASE,
      failingChecks: ['tests'],
      cached: false,
      evidence: [
        {
          checker: 'tests',
          command: 'bash scripts/verify.sh --no-e2e',
          exitCode: 1,
          tail: 'verify.sh failed: FAIL  src/math.test.ts > add > adds',
        },
      ],
    });
    const outcome = await runIssue(request, policy, ports);
    expect(outcome).toMatchObject({ state: 'released', reason: 'environment', failingChecks: ['tests'] });
    expect(outcome).not.toHaveProperty('baseInconclusive');
    const [msg] = released(log);
    expect(msg).toContain(`origin/main ${BASE.slice(0, 8)} fails tests before PLAN`);
    expect(msg).toContain('exit 1');
    expect(msg).toContain('FAIL  src/math.test.ts > add > adds');
  });
});
