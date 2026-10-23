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
  failover: { triggers: [], maxRetries: 0, cooldownMs: 0, escalateAfterTierExhausted: false },
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
