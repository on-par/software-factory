import { workKeyFromIssue } from '../work/work-key.js';
import { join } from 'node:path';

import type { Octokit } from '@octokit/rest';
import { afterAll, describe, expect, it, vi } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';
import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import type { BuildResult, buildPhase as realBuildPhase } from '../phases/build.js';
import type { CheckPhaseResult, checkPhase as realCheckPhase } from '../phases/check.js';
import type { PlanResult, planPhase as realPlanPhase } from '../phases/plan.js';
import type { ShipResult, shipPhase as realShipPhase } from '../phases/ship.js';
import type { DesignArtifact } from '../types/index.js';
import { ProviderBreaker } from '../router/breaker.js';
import { ModelRouter } from '../router/index.js';
import type { WorkRequest } from '../work/index.js';
import type { RunPolicy } from './policy.js';
import { LaneFileGuard } from './lane-file-guard.js';
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
const breakerDir = tempDirs.makeSync('run-issue-file-overlap-');
afterAll(() => tempDirs.cleanup());

const request: RunRequest = {
  issue: workKeyFromIssue(1),
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

const design: DesignArtifact = {
  restatedProblem: 'problem',
  approach: { chosen: 'chosen', rejected: [] },
  interfacesTouched: [],
  targetTypes: [{ name: 'Thing', file: 'src/shared.ts', kind: 'changed' }],
  signatures: [],
  callGraph: [],
  behaviorContract: [],
  verificationPlan: [],
  riskBlastRadius: 'low',
  openQuestions: [],
};

const issues = { createComment: vi.fn(), updateComment: vi.fn(), addLabels: vi.fn(), removeLabel: vi.fn() };

function makePorts(overrides: Partial<RunPorts>, events: Array<[string, string]>): RunPorts {
  return {
    router: new ModelRouter(MODELS, ROUTES),
    octokit: Object.assign({} as Octokit, { rest: { issues } }),
    workspace: { path: '/tmp/wt', dispose: async () => {} } as Workspace,
    events: () => (type, msg) => events.push([type, msg]),
    breaker: new ProviderBreaker(join(breakerDir, 'breaker.json')),
    resolveConstitution: () => null,
    planPhase: vi.fn<typeof realPlanPhase>().mockResolvedValue({
      ok: true,
      route: 'claude',
      specPath: '/tmp/wt/spec.md',
      model: 'm',
      designArtifact: design,
    } satisfies PlanResult),
    buildPhase: vi
      .fn<typeof realBuildPhase>()
      .mockResolvedValue({ ok: true, model: 'my-model', route: 'command' } satisfies BuildResult),
    checkPhase: vi.fn<typeof realCheckPhase>().mockResolvedValue({
      passed: true,
      summary: { failures: 0, passes: 1, skips: 0, total: 1, results: [] },
      reworkRounds: 0,
    } satisfies CheckPhaseResult),
    shipPhase: vi.fn<typeof realShipPhase>().mockResolvedValue({ ok: true, prNumber: 42 } satisfies ShipResult),
    ...overrides,
  };
}

describe('runIssue — same-file lane hold defers instead of parking (#3576)', () => {
  it('a live same-file collision defers the issue instead of parking it held', async () => {
    const collision = { issue: 3232, file: 'src/shared.ts' };
    const guard = new LaneFileGuard(join(breakerDir, 'lane-files-defer.json'));
    vi.spyOn(guard, 'findCollision').mockResolvedValue(collision);
    const recordHold = vi.spyOn(guard, 'recordHold').mockResolvedValue();
    const register = vi.spyOn(guard, 'register');
    const events: Array<[string, string]> = [];
    const ports = makePorts({ laneFileGuard: guard }, events);
    const outcome = await runIssue({ ...request, issue: workKeyFromIssue(1896) }, policy, ports);
    expect(outcome).toMatchObject({ state: 'released', reason: 'file-overlap', holder: 3232, file: 'src/shared.ts' });
    expect(outcome.state).not.toBe('parked');
    expect(events.some(([type]) => type === 'held')).toBe(false);
    expect(
      events.some(([type, msg]) => type === 'issue_deferred' && msg.includes('#3232') && msg.includes('src/shared.ts')),
    ).toBe(true);
    expect(issues.createComment).not.toHaveBeenCalled();
    expect(issues.updateComment).not.toHaveBeenCalled();
    expect(recordHold).toHaveBeenCalledWith('o/r', workKeyFromIssue(1896), collision);
    expect(register).not.toHaveBeenCalled();
    expect(ports.buildPhase).not.toHaveBeenCalled();
  });

  it('still defers when recording the hold fails', async () => {
    const guard = new LaneFileGuard(join(breakerDir, 'lane-files-defer-fail.json'));
    vi.spyOn(guard, 'findCollision').mockResolvedValue({ issue: 7, file: 'src/shared.ts' });
    vi.spyOn(guard, 'recordHold').mockRejectedValue(new Error('ENOSPC'));
    const events: Array<[string, string]> = [];
    const outcome = await runIssue(request, policy, makePorts({ laneFileGuard: guard }, events));
    expect(outcome).toMatchObject({ state: 'released', reason: 'file-overlap' });
    expect(events.some(([type, msg]) => type === 'environment_warning' && msg.includes('ENOSPC'))).toBe(true);
  });

  it('a crossRunStuck CHECK result still parks held with the needs-a-human hint', async () => {
    const events: Array<[string, string]> = [];
    const ports = makePorts(
      {
        checkPhase: vi.fn<typeof realCheckPhase>().mockResolvedValue({
          passed: false,
          summary: { failures: 1, passes: 0, skips: 0, total: 1, results: [] },
          reworkRounds: 1,
          stuck: true,
          crossRunStuck: true,
        } satisfies CheckPhaseResult),
      },
      events,
    );
    const outcome = await runIssue(request, policy, ports);
    expect(outcome).toMatchObject({ state: 'parked', reason: 'held' });
  });
});
