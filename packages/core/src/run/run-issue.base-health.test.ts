import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Octokit } from '@octokit/rest';
import { createTempDirs } from '@on-par/factory-core/testing';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { ProviderBreaker } from '../router/breaker.js';
import { ModelRouter } from '../router/index.js';
import type { Constitution } from '../types/index.js';
import type { WorkRequest } from '../work/index.js';
import type { RunPolicy } from './policy.js';
import type { PlanResult, planPhase as realPlanPhase } from '../phases/plan.js';
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

const tempDirs = createTempDirs();
afterEach(() => tempDirs.cleanup());
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

const PLAN_PARKED: PlanResult = {
  ok: false,
  route: 'claude',
  specPath: '/tmp/wt/spec.md',
  model: 'm',
  designArtifact: null,
  escalate: 'stop here',
};

describe('runIssue — no pre-PLAN base health (#4029)', () => {
  const makePorts = (extra: Partial<RunPorts> = {}) => {
    const log = vi.fn<(type: string, msg: string) => void>();
    const planPhase = vi.fn<typeof realPlanPhase>().mockResolvedValue(PLAN_PARKED);
    const ports: RunPorts = {
      router: new ModelRouter(MODELS, ROUTES),
      octokit: {} as Octokit,
      workspace: { path: '/tmp/wt', dispose: async () => {} } as Workspace,
      events: () => log,
      breaker: new ProviderBreaker(join(breakerDir, 'breaker.json')),
      resolveConstitution: () => null,
      planPhase,
      ...extra,
    };
    return { ports, log, planPhase };
  };

  it('runs no base health check before PLAN even when a red checker is supplied', async () => {
    const spy = vi
      .fn()
      .mockResolvedValue({ kind: 'red', baseSha: 'a'.repeat(40), failingChecks: ['tests'], cached: false });
    const { ports, planPhase } = makePorts();
    const loose = { ...ports, checkBaseHealth: spy } as RunPorts;
    await runIssue(request, policy, loose);
    expect(spy).not.toHaveBeenCalled();
    expect(planPhase).toHaveBeenCalledTimes(1);
  });

  it('a red origin/main no longer releases the issue before PLAN', async () => {
    const spy = vi
      .fn()
      .mockResolvedValue({ kind: 'red', baseSha: 'c'.repeat(40), failingChecks: ['tests'], cached: false });
    const { ports, log } = makePorts();
    const outcome = await runIssue(request, policy, { ...ports, checkBaseHealth: spy } as RunPorts);
    expect(outcome).not.toMatchObject({ state: 'released', reason: 'environment' });
    expect(log.mock.calls.filter((c) => c[0] === 'environment-released')).toEqual([]);
  });

  it('config preflight still parks a bad config before PLAN with no base health run', async () => {
    const dir = await tempDirs.make('run-issue-no-base-health-');
    try {
      const path = join(dir, 'constitution.md');
      writeFileSync(path, '---\nproduct: acme\nversion: 1\ncheckers:\n  - bogus_checker\n---\nbody');
      const spy = vi.fn();
      const { ports, planPhase } = makePorts({
        resolveConstitution: (): Constitution => ({
          source: 'repo',
          product: 'acme',
          version: 1,
          checkers: ['bogus_checker'],
          body: 'stds',
          path,
          requireTests: true,
          repoInstance: { relPath: '.factory/constitution.md', absPath: path },
        }),
      });
      const outcome = await runIssue(request, policy, { ...ports, checkBaseHealth: spy } as RunPorts);
      expect(outcome).toMatchObject({ state: 'parked', reason: 'config' });
      expect(planPhase).not.toHaveBeenCalled();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
