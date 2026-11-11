// runIssue's pre-PLAN base health gate for an explicit base-repair run (RunRequest.baseHealthRepair).
// Every port is a plain recording fake: the tests read what the run did, not how often a mock was called.
import { join } from 'node:path';

import { createTempDirs } from '@on-par/factory-core/testing';
import type { Octokit } from '@octokit/rest';
import { afterAll, describe, expect, it } from 'vitest';

import type { BaseHealthResult } from '../checkers/base-health.js';
import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import type { PlanResult } from '../phases/plan.js';
import { ProviderBreaker } from '../router/breaker.js';
import { ModelRouter } from '../router/index.js';
import type { WorkRequest } from '../work/index.js';
import type { RunPolicy } from './policy.js';
import type { Workspace } from './ports.js';
import { runIssue, type RunPorts, type RunRequest } from './run-issue.js';

const WORK: WorkRequest = {
  id: 'github-issue:o/r#1',
  kind: 'github-issue',
  title: 'Repair the base',
  brief: 'fix the test that is red on main',
  acceptanceCriteria: [],
};

const ROUTES: RoutesConfig = {
  version: 1,
  routes: { build_claude: { tier: 'worker', description: 'stub', requires: 'claude' } },
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
const breakerDir = dirs.makeSync('run-issue-base-repair-');
afterAll(() => dirs.cleanup());

const request: RunRequest = {
  issue: 1,
  repo: 'o/r',
  branch: 'issue-1-repair-the-base',
  specPath: '/tmp/wt/spec.md',
  work: WORK,
  startedAt: '2026-01-01T00:00:00.000Z',
  options: { interactive: false, autoRework: true, approvePlan: false, sandboxDisabled: false },
  timeouts: { plan: 60, build: 60, check: 60, approval: 60, tests: 600 },
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

const BASE = 'b'.repeat(40);
const RED: BaseHealthResult = {
  kind: 'red',
  baseSha: BASE,
  failingChecks: ['tests'],
  cached: false,
  evidence: [
    {
      checker: 'tests',
      command: 'bash scripts/verify.sh --no-e2e',
      exitCode: 1,
      tail: 'FAIL  src/math.test.ts > add > adds',
    },
  ],
};
const INCONCLUSIVE: BaseHealthResult = {
  kind: 'inconclusive',
  baseSha: BASE,
  failingChecks: [],
  cached: false,
  evidence: [
    {
      checker: 'tests',
      cause: 'timeout',
      command: 'bash scripts/verify.sh --no-e2e',
      timeoutSeconds: 600,
      tail: 'timed out',
    },
  ],
};

/** PLAN ends the run right after it starts (a config park), so reaching it is the whole observation. */
const PLAN_STOPS: PlanResult = {
  ok: false,
  route: 'claude',
  specPath: '/tmp/wt/spec.md',
  model: 'm',
  designArtifact: null,
  escalate: 'stop after PLAN started',
  parkReason: 'config',
};

function runWith(health: BaseHealthResult, extra: Partial<RunRequest> = {}) {
  const events: Array<{ type: string; msg: string }> = [];
  const phasesEntered: string[] = [];
  const ports: RunPorts = {
    router: new ModelRouter(MODELS, ROUTES),
    octokit: {} as Octokit,
    workspace: { path: '/tmp/wt', dispose: async () => {} } as Workspace,
    events: () => (type, msg) => void events.push({ type, msg }),
    breaker: new ProviderBreaker(join(breakerDir, 'breaker.json')),
    resolveConstitution: () => null,
    checkBaseHealth: async () => health,
    planPhase: async () => {
      phasesEntered.push('plan');
      return PLAN_STOPS;
    },
    buildPhase: async () => {
      phasesEntered.push('build');
      throw new Error('BUILD must not run in these tests');
    },
  };
  const outcome = runIssue({ ...request, ...extra }, policy, ports);
  return { outcome, events, phasesEntered };
}

const ofType = (events: Array<{ type: string; msg: string }>, type: string) =>
  events.filter((e) => e.type === type).map((e) => e.msg);

describe('runIssue — explicit base-repair run (FACTORY_BASE_HEALTH_REPAIR=1)', () => {
  it('a red base with the repair signal logs base_repair_proceeding with the failing checks and enters PLAN', async () => {
    const run = runWith(RED, { baseHealthRepair: true });
    const outcome = await run.outcome;

    expect(run.phasesEntered).toEqual(['plan']);
    expect(outcome.state).not.toBe('released');
    expect(outcome).toMatchObject({ state: 'parked', reason: 'config' });
    const [proceeding, ...more] = ofType(run.events, 'base_repair_proceeding');
    expect(more).toEqual([]);
    expect(proceeding).toContain(`origin/main ${BASE.slice(0, 8)} fails tests before PLAN`);
    expect(proceeding).toContain('FAIL  src/math.test.ts > add > adds');
    expect(proceeding).toContain('FACTORY_BASE_HEALTH_REPAIR=1');
    expect(proceeding).toContain('CHECK still compares against the base baseline');
    expect(ofType(run.events, 'environment-released')).toEqual([]);
  });

  it('names a stacked parent ref when the run tests one', async () => {
    const run = runWith(RED, { baseHealthRepair: true, parentBaseRef: 'origin/feature' });
    await run.outcome;
    expect(ofType(run.events, 'base_repair_proceeding')[0]).toContain(`origin/feature ${BASE.slice(0, 8)} fails tests`);
  });

  it('an inconclusive base still releases before PLAN with the repair signal', async () => {
    const run = runWith(INCONCLUSIVE, { baseHealthRepair: true });
    const outcome = await run.outcome;

    expect(outcome).toMatchObject({ state: 'released', reason: 'environment', baseSha: BASE, baseInconclusive: true });
    expect(run.phasesEntered).toEqual([]);
    expect(ofType(run.events, 'base_repair_proceeding')).toEqual([]);
    expect(ofType(run.events, 'environment-released')[0]).toContain('could not run');
  });

  it('a red that only awaits CI for a timed-out compile still releases with the repair signal', async () => {
    const awaiting: BaseHealthResult = { ...RED, failingChecks: ['compile'], awaitingCi: true };
    const run = runWith(awaiting, { baseHealthRepair: true });
    const outcome = await run.outcome;

    expect(outcome).toMatchObject({ state: 'released', reason: 'environment', awaitingCi: true });
    expect(run.phasesEntered).toEqual([]);
    expect(ofType(run.events, 'base_repair_proceeding')).toEqual([]);
  });

  it.each([
    ['absent', {}],
    ['false', { baseHealthRepair: false }],
  ] as const)('a red base with the repair signal %s releases before PLAN, unchanged', async (_label, extra) => {
    const run = runWith(RED, extra);
    const outcome = await run.outcome;

    expect(outcome).toMatchObject({
      state: 'released',
      reason: 'environment',
      baseSha: BASE,
      failingChecks: ['tests'],
    });
    expect(outcome).not.toHaveProperty('baseInconclusive');
    expect(run.phasesEntered).toEqual([]);
    expect(ofType(run.events, 'base_repair_proceeding')).toEqual([]);
    expect(ofType(run.events, 'environment-released')[0]).toContain(
      `origin/main ${BASE.slice(0, 8)} fails tests before PLAN`,
    );
  });

  it('a green base enters PLAN without a repair event, signal or not', async () => {
    for (const extra of [{}, { baseHealthRepair: true }]) {
      const run = runWith({ kind: 'green', baseSha: BASE, failingChecks: [], cached: false }, extra);
      await run.outcome;
      expect(run.phasesEntered).toEqual(['plan']);
      expect(ofType(run.events, 'base_repair_proceeding')).toEqual([]);
    }
  });
});
