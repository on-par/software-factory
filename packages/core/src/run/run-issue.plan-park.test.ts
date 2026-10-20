import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Octokit } from '@octokit/rest';
import { afterAll, describe, expect, it, vi } from 'vitest';

import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import type { buildPhase as realBuildPhase } from '../phases/build.js';
import type { checkPhase as realCheckPhase } from '../phases/check.js';
import type { PlanResult, planPhase as realPlanPhase } from '../phases/plan.js';
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
  failover: { triggers: [], maxRetries: 0, cooldownMs: 0, escalateAfterTierExhausted: false },
  routingRules: {},
  harnesses: {
    'my-agent': { command: 'my-agent {model}', prompt: 'stdin', output: 'stdout', agentic: true, usage: 'none' },
  },
};

const breakerDir = mkdtempSync(join(tmpdir(), 'run-issue-plan-park-'));
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

const PLAN_FAILED: PlanResult = {
  ok: false,
  route: 'claude',
  specPath: '/tmp/wt/spec.md',
  model: 'm',
  designArtifact: null,
};

describe('runIssue — PLAN failure mapping (#3269)', () => {
  it('a PLAN result with parkReason config parks config and does not build', async () => {
    const planPhase = vi.fn<typeof realPlanPhase>().mockResolvedValue({
      ...PLAN_FAILED,
      escalate: 'PLAN could not write its spec to /x/plans/issue-1.md',
      parkReason: 'config',
    });
    const buildPhase = vi.fn<typeof realBuildPhase>();
    const events: Array<[string, string]> = [];
    const outcome = await runIssue(
      request,
      policy,
      portsWith(planPhase, buildPhase, (t, m) => events.push([t, m])),
    );
    expect(outcome).toMatchObject({ state: 'parked', reason: 'config' });
    const parked = events.find(([type]) => type === 'config')?.[1] ?? '';
    expect(parked).toContain('/x/plans/issue-1.md');
    expect(parked).toContain('then fix the harness writable roots and run factory unpark 1');
    expect(buildPhase).not.toHaveBeenCalled();
  });

  it('a PLAN split escalation still escalates', async () => {
    const planPhase = vi
      .fn<typeof realPlanPhase>()
      .mockResolvedValue({ ...PLAN_FAILED, escalate: 'ESCALATE: please split this' });
    const buildPhase = vi.fn<typeof realBuildPhase>();
    const outcome = await runIssue(
      request,
      policy,
      portsWith(planPhase, buildPhase, () => {}),
    );
    expect(outcome.state).toBe('escalated');
    expect(buildPhase).not.toHaveBeenCalled();
  });
});
