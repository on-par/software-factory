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

const breakerDir = mkdtempSync(join(tmpdir(), 'run-issue-command-'));
afterAll(() => rmSync(breakerDir, { recursive: true, force: true }));

const request: RunRequest = {
  issue: 1,
  repo: 'o/r',
  branch: 'issue-1-fix-the-thing',
  specPath: '/tmp/wt/spec.md',
  work: WORK,
  startedAt: '2026-01-01T00:00:00.000Z',
  options: { interactive: false, autoRework: true, approvePlan: false, sandboxDisabled: false },
  timeouts: { plan: 60, build: 60, check: 60, approval: 60, tests: 60 },
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

describe('runIssue — command build route (#2872)', () => {
  it('a build pin on a declared agentic harness runs BUILD on the command route without model_override_ignored', async () => {
    const events: Array<[string, string]> = [];
    const planPhase = vi.fn<typeof realPlanPhase>().mockResolvedValue({
      ok: true,
      route: 'claude',
      specPath: '/tmp/wt/spec.md',
      model: 'm',
      designArtifact: null,
    } satisfies PlanResult);
    const buildPhase = vi
      .fn<typeof realBuildPhase>()
      .mockResolvedValue({ ok: true, model: 'my-model', route: 'command' } satisfies BuildResult);
    const checkPhase = vi.fn<typeof realCheckPhase>().mockResolvedValue({
      passed: true,
      summary: { failures: 0, passes: 1, skips: 0, total: 1, results: [] },
      reworkRounds: 0,
    } satisfies CheckPhaseResult);
    const shipPhase = vi.fn<typeof realShipPhase>().mockResolvedValue({ ok: true, prNumber: 42 } satisfies ShipResult);
    const ports: RunPorts = {
      router: new ModelRouter(MODELS, ROUTES),
      octokit: {} as Octokit,
      workspace: { path: '/tmp/wt', dispose: async () => {} } as Workspace,
      events: () => (type: string, msg: string) => events.push([type, msg]),
      breaker: new ProviderBreaker(join(breakerDir, 'breaker.json')),
      resolveConstitution: () => null,
      planPhase,
      buildPhase,
      checkPhase,
      shipPhase,
    };

    await runIssue(request, policy, ports);

    expect(planPhase.mock.calls[0][0].preferredRoute).toBe('command');
    expect(buildPhase.mock.calls[0][0]).toMatchObject({
      route: 'command',
      modelOverride: 'my-model',
      pinnedModel: true,
    });
    expect(events.some(([t]) => t === 'model_override_ignored')).toBe(false);
    expect(checkPhase.mock.calls[0][0].reworkRoute).toBe('command');
    expect(checkPhase.mock.calls[0][0].reworkModel).toBe('my-model');
  });
});
