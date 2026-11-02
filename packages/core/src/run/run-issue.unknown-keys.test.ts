import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createTempDirs } from '@on-par/factory-core/testing';
import type { Octokit } from '@octokit/rest';
import { afterAll, describe, expect, it, vi } from 'vitest';

import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import type { buildPhase as realBuildPhase } from '../phases/build.js';
import type { checkPhase as realCheckPhase } from '../phases/check.js';
import type { planPhase as realPlanPhase } from '../phases/plan.js';
import type { shipPhase as realShipPhase } from '../phases/ship.js';
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

const dirs = createTempDirs();
const breakerDir = dirs.makeSync('run-issue-unknown-keys-');
afterAll(() => dirs.cleanup());

const baseRequest: RunRequest = {
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

function portsWith(
  planPhase: typeof realPlanPhase,
  buildPhase: typeof realBuildPhase,
  events: (type: string, msg: string) => void,
): RunPorts {
  return {
    router: new ModelRouter(MODELS, ROUTES),
    octokit: {} as Octokit,
    workspace: { path: '/tmp/wt', dispose: async () => {} } as Workspace,
    events: () => events,
    breaker: new ProviderBreaker(join(breakerDir, 'breaker.json')),
    resolveConstitution: () => null,
    planPhase,
    buildPhase,
    checkPhase: vi.fn<typeof realCheckPhase>(),
    shipPhase: vi.fn<typeof realShipPhase>(),
  };
}

describe('runIssue unknown config keys (#3568)', () => {
  it('logs one config_unknown_key warning naming sandbox.foo and proceeds to PLAN', async () => {
    const absPath = join(dirs.makeSync('unknown-keys-cfg-'), 'config.yaml');
    writeFileSync(absPath, 'sandbox:\n  foo: 1\n');
    const planPhase = vi
      .fn<typeof realPlanPhase>()
      .mockResolvedValue({ ok: true, route: 'claude', specPath: '/tmp/wt/spec.md', model: 'm', designArtifact: null });
    const buildPhase = vi
      .fn<typeof realBuildPhase>()
      .mockResolvedValue({ ok: false, model: 'm', route: 'claude', reason: 'no_diff' });
    const events: Array<[string, string]> = [];
    await runIssue(
      { ...baseRequest, repoConfigFile: { absPath, relPath: '.factory/config.yaml' } },
      policy,
      portsWith(planPhase, buildPhase, (t, m) => events.push([t, m])),
    );
    const warnings = events.filter(([type]) => type === 'config_unknown_key');
    expect(warnings).toHaveLength(1);
    expect(warnings[0][1]).toContain('.factory/config.yaml:2');
    expect(warnings[0][1]).toContain('sandbox.foo');
    expect(planPhase).toHaveBeenCalledTimes(1);
  });

  it('logs nothing for a config of known keys', async () => {
    const absPath = join(dirs.makeSync('unknown-keys-cfg-'), 'config.yaml');
    writeFileSync(absPath, 'sandbox:\n  writablePaths: []\n');
    const planPhase = vi
      .fn<typeof realPlanPhase>()
      .mockResolvedValue({ ok: true, route: 'claude', specPath: '/tmp/wt/spec.md', model: 'm', designArtifact: null });
    const buildPhase = vi
      .fn<typeof realBuildPhase>()
      .mockResolvedValue({ ok: false, model: 'm', route: 'claude', reason: 'no_diff' });
    const events: Array<[string, string]> = [];
    await runIssue(
      { ...baseRequest, repoConfigFile: { absPath, relPath: '.factory/config.yaml' } },
      policy,
      portsWith(planPhase, buildPhase, (t, m) => events.push([t, m])),
    );
    expect(events.some(([type]) => type === 'config_unknown_key')).toBe(false);
  });

  async function eventsFor(config: string): Promise<Array<[string, string]>> {
    const absPath = join(dirs.makeSync('unknown-keys-cfg-'), 'config.yaml');
    writeFileSync(absPath, config);
    const planPhase = vi
      .fn<typeof realPlanPhase>()
      .mockResolvedValue({ ok: true, route: 'claude', specPath: '/tmp/wt/spec.md', model: 'm', designArtifact: null });
    const buildPhase = vi
      .fn<typeof realBuildPhase>()
      .mockResolvedValue({ ok: false, model: 'm', route: 'claude', reason: 'no_diff' });
    const events: Array<[string, string]> = [];
    await runIssue(
      { ...baseRequest, repoConfigFile: { absPath, relPath: '.factory/config.yaml' } },
      policy,
      portsWith(planPhase, buildPhase, (t, m) => events.push([t, m])),
    );
    expect(planPhase).toHaveBeenCalledTimes(1);
    return events;
  }

  it('logs one config_invalid_value warning for an unknown sandbox.codexSandbox and proceeds to PLAN (#3829)', async () => {
    const events = await eventsFor('sandbox:\n  codexSandbox: read-only\n');
    const warnings = events.filter(([type]) => type === 'config_invalid_value');
    expect(warnings).toHaveLength(1);
    expect(warnings[0][1]).toContain('.factory/config.yaml:2');
    expect(warnings[0][1]).toContain('read-only');
    expect(warnings[0][1]).toContain('set sandbox.codexSandbox to "danger-full-access" or "workspace-write"');
  });

  it('logs no config warning for a valid sandbox.codexSandbox (#3829)', async () => {
    const events = await eventsFor('sandbox:\n  codexSandbox: workspace-write\n');
    expect(events.some(([type]) => type === 'config_invalid_value' || type === 'config_unknown_key')).toBe(false);
  });
});
