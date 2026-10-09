import { execFile as execFileCb } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { Octokit } from '@octokit/rest';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { parseSlicePlanComment, renderSlicePlanComment, type SlicePlan } from '../readiness/slice-plan.js';
import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import type { BuildResult, buildPhase as realBuildPhase } from '../phases/build.js';
import type { CheckPhaseResult, checkPhase as realCheckPhase } from '../phases/check.js';
import type { PlanResult, planPhase as realPlanPhase } from '../phases/plan.js';
import type { ShipResult, shipPhase as realShipPhase } from '../phases/ship.js';
import type { PrShadowVerdict } from '../review/classifier.js';
import { DEFAULT_REVIEW_FLOOR_RULES } from '../review/floor.js';
import { ProviderBreaker } from '../router/breaker.js';
import { ModelRouter } from '../router/index.js';
import type { CheckSummary, Constitution, DesignArtifact } from '../types/index.js';
import type { StewardCommentGitHubClient, StewardIssueComment } from '../steward/comment.js';
import type { RunStewardPorts } from '../steward/run.js';
import type { WorkRequest } from '../work/index.js';
import { LaneFileGuard } from './lane-file-guard.js';
import type { RunPolicy } from './policy.js';
import type { Environment, Workspace } from './ports.js';
import { runIssue, type RunPorts, type RunRequest } from './run-issue.js';

const planPhase = vi.fn<typeof realPlanPhase>();
const buildPhase = vi.fn<typeof realBuildPhase>();
const checkPhase = vi.fn<typeof realCheckPhase>();
const shipPhase = vi.fn<typeof realShipPhase>();

const execFile = promisify(execFileCb);

const PLAN_OK: PlanResult = { ok: true, route: 'codex', specPath: '/tmp/wt/spec.md', model: 'm', designArtifact: null };
const BUILD_OK: BuildResult = { ok: true, model: 'm', route: 'codex' };
const CHECK_SUMMARY: CheckSummary = { failures: 0, passes: 1, skips: 0, total: 1, results: [] };
const CHECK_OK: CheckPhaseResult = { passed: true, summary: CHECK_SUMMARY, reworkRounds: 0 };
const SHIP_OK: ShipResult = { ok: true, prNumber: 42 };

const WORK: WorkRequest = {
  id: 'github-issue:o/r#1',
  kind: 'github-issue',
  title: 'Fix the thing',
  brief: 'do the thing',
  acceptanceCriteria: [],
};

function baseRequest(overrides: Partial<RunRequest> = {}): RunRequest {
  return {
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
    ...overrides,
  };
}

const ROUTES: RoutesConfig = {
  version: 1,
  routes: {
    build_claude: { tier: 'worker', description: 'stub', requires: 'claude' },
    build_codex: { tier: 'worker', description: 'stub', requires: 'codex' },
  },
};

/** A real ModelRouter (matching the rest of core's tests, e.g. phases/build.test.ts)
 *  over a minimal in-memory model set — avoids hand-rolling a partial ModelRouter
 *  double, which the codebase's structural-typing lint forbids for a class this shaped. */
function fakeRouter(modelDefs: Record<string, { provider: string; codex?: boolean }> = {}): ModelRouter {
  const models: ModelsConfig = {
    version: 1,
    models: Object.fromEntries(
      Object.entries(modelDefs).map(([id, def]) => [
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
        },
      ]),
    ),
    tiers: { worker: Object.keys(modelDefs) },
    failover: { triggers: [], maxRetries: 0, cooldownMs: 0, escalateAfterTierExhausted: false },
    routingRules: {},
  };
  return new ModelRouter(models, ROUTES);
}

function basePolicy(overrides: Partial<RunPolicy> = {}): RunPolicy {
  return {
    models: {
      version: 1,
      models: {},
      tiers: {},
      failover: { triggers: [], maxRetries: 0, cooldownMs: 0, escalateAfterTierExhausted: false },
      routingRules: {},
    },
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
    ...overrides,
  };
}

// Breaker files live in a private, unpredictable temp dir, never at a fixed /tmp path.
const breakerDir = mkdtempSync(join(tmpdir(), 'run-issue-'));
afterAll(() => rmSync(breakerDir, { recursive: true, force: true }));

let breakerFileCounter = 0;

function basePorts(overrides: Partial<RunPorts> = {}): RunPorts {
  breakerFileCounter += 1;
  return {
    router: fakeRouter(),
    octokit: {} as Octokit,
    workspace: { path: '/tmp/wt', dispose: async () => {} } as Workspace,
    events: () => vi.fn(),
    breaker: new ProviderBreaker(join(breakerDir, `breaker-${breakerFileCounter}.json`)),
    resolveConstitution: () => null,
    planPhase,
    buildPhase,
    checkPhase,
    shipPhase,
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(planPhase).mockReset().mockResolvedValue(PLAN_OK);
  vi.mocked(buildPhase).mockReset().mockResolvedValue(BUILD_OK);
  vi.mocked(checkPhase).mockReset().mockResolvedValue(CHECK_OK);
  vi.mocked(shipPhase).mockReset().mockResolvedValue(SHIP_OK);
});

describe('runIssue — recorded remote branch SHA (#1869)', () => {
  it('threads the recorded remote SHA into shipPhase, undefined without a record', async () => {
    await runIssue(baseRequest(), basePolicy(), basePorts());
    expect(vi.mocked(shipPhase).mock.calls[0][0].recordedRemoteSha).toBeUndefined();

    vi.mocked(shipPhase).mockClear();
    const workspace = { path: '/tmp/wt', dispose: async () => {}, remoteBranch: { sha: 'd'.repeat(40) } } as Workspace;
    await runIssue(baseRequest(), basePolicy(), basePorts({ workspace }));
    expect(vi.mocked(shipPhase).mock.calls[0][0].recordedRemoteSha).toBe('d'.repeat(40));
  });
});

describe('runIssue — invariant 1: constitution resolved exactly once', () => {
  it('calls resolveConstitution exactly once, before BUILD, and passes the same value to every phase', async () => {
    const constitution: Constitution = {
      source: 'bundled',
      product: 'acme',
      version: 1,
      checkers: [],
      body: 'stds',
      path: '/tmp/acme.md',
      requireTests: true,
    };
    const resolveConstitution = vi.fn(() => constitution);
    const outcome = await runIssue(baseRequest(), basePolicy(), basePorts({ resolveConstitution }));

    expect(resolveConstitution).toHaveBeenCalledTimes(1);
    expect(outcome.state).toBe('ready');
    for (const call of [
      vi.mocked(planPhase).mock.calls[0],
      vi.mocked(buildPhase).mock.calls[0],
      vi.mocked(checkPhase).mock.calls[0],
    ]) {
      expect(call[0].constitution).toBe(constitution);
    }
  });
});

describe('runIssue — per-run id threading (#1910)', () => {
  it('mints one runId shared by BUILD and CHECK, fresh for every run', async () => {
    await runIssue(baseRequest(), basePolicy(), basePorts());
    const buildId = vi.mocked(buildPhase).mock.calls[0][0].runId;
    expect(buildId).toMatch(/^[0-9a-f]{12}$/);
    expect(vi.mocked(checkPhase).mock.calls[0][0].runId).toBe(buildId);

    vi.mocked(buildPhase).mockClear();
    await runIssue(baseRequest(), basePolicy(), basePorts());
    expect(vi.mocked(buildPhase).mock.calls[0][0].runId).not.toBe(buildId);
  });
});

describe('runIssue — .NET env event (#1911)', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    vi.unstubAllEnvs();
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  async function runWith(marker: string): Promise<Array<[string, string]>> {
    for (const k of ['DiffEngine_Disabled', 'DOTNET_CLI_TELEMETRY_OPTOUT', 'DOTNET_NOLOGO', 'DOTNET_TieredPGO']) {
      vi.stubEnv(k, undefined);
    }
    const path = await mkdtemp(join(tmpdir(), 'run-issue-dotnet-'));
    dirs.push(path);
    await writeFile(join(path, marker), '');
    const events: Array<[string, string]> = [];
    const log = vi.fn((type: string, msg: string) => events.push([type, msg]));
    const workspace = { path, dispose: async () => {} } as Workspace;
    await runIssue(baseRequest(), basePolicy(), basePorts({ workspace, events: () => log }));
    return events;
  }

  it('logs one environment_dotnet event naming the applied variables for a .NET workspace', async () => {
    const found = (await runWith('App.sln')).filter(([t]) => t === 'environment_dotnet');
    expect(found).toHaveLength(1);
    expect(found[0][1]).toContain('DiffEngine_Disabled=true');
    expect(found[0][1]).toContain('DOTNET_NOLOGO=1');
    expect(found[0][1]).toContain('SharedCompilationId=factory-');
  });

  it('logs no environment_dotnet event for a non-.NET workspace', async () => {
    const events = await runWith('package.json');
    expect(events.some(([t]) => t === 'environment_dotnet')).toBe(false);
  });
});

describe('runIssue — publishFromBuild threading (#1867)', () => {
  it('passes publishFromBuild to buildPhase, undefined by default', async () => {
    await runIssue(baseRequest(), basePolicy(), basePorts());
    expect(vi.mocked(buildPhase).mock.calls[0][0].publishFromBuild).toBeUndefined();

    vi.mocked(buildPhase).mockClear();
    await runIssue(baseRequest({ publishFromBuild: true }), basePolicy(), basePorts());
    expect(vi.mocked(buildPhase).mock.calls[0][0].publishFromBuild).toBe(true);
  });
});

describe('runIssue — size gate mode (#2048)', () => {
  it.each([
    [undefined, true],
    ['file', true],
    ['slice', true],
    ['off', false],
  ] as const)('sizeGateMode %s -> enforceSizeGate %s', async (mode, expected) => {
    await runIssue(baseRequest({ sizeGateMode: mode }), basePolicy(), basePorts());
    expect(vi.mocked(planPhase).mock.calls[0][0].enforceSizeGate).toBe(expected);
    expect(vi.mocked(planPhase).mock.calls[0][0].sizeGateMode).toBe(mode);
  });

  it('passes maxSlices through to planPhase (ADR-0156)', async () => {
    await runIssue(baseRequest({ sizeGateMode: 'slice', maxSlices: 7 }), basePolicy(), basePorts());
    expect(vi.mocked(planPhase).mock.calls[0][0].maxSlices).toBe(7);
  });
});

describe('runIssue — slice shipping (ADR-0147)', () => {
  const story = (n: number) => ({
    schemaVersion: 1 as const,
    kind: 'story' as const,
    filesLikelyTouched: [],
    labels: [],
    title: `Story ${n}`,
    role: 'operator',
    want: `thing ${n} works`,
    soThat: 'value',
    problemStatement: `Problem ${n}`,
    inScope: [`Scope ${n}`],
    outOfScope: ['Persistent storage'],
    acceptanceCriteria: [{ name: `ac ${n}`, given: [], when: ['run'], then: ['works'] }],
    verification: [{ command: 'npm test', passWhen: 'passes' }],
    tracesTo: ['INT-PROBLEM-01'],
  });
  const slicePlan: SlicePlan = {
    issue: 1,
    slices: [
      { index: 1, title: 'One', story: story(1) as never, state: 'merged', prNumber: 10 },
      { index: 2, title: 'Two', story: story(2) as never, state: 'pending' },
      { index: 3, title: 'Three', story: story(3) as never, state: 'pending' },
    ],
  };

  function sliceSetup(updateComment: ReturnType<typeof vi.fn>, events: ReturnType<typeof vi.fn> = vi.fn()) {
    vi.mocked(planPhase).mockResolvedValue({ ...PLAN_OK, slice: { plan: slicePlan, index: 2 } });
    const octokit: Octokit = {
      rest: {
        users: { getAuthenticated: async () => ({ data: { id: 7 } }) },
        issues: {
          listComments: async () => ({ data: [{ id: 99, user: { id: 7 }, body: renderSlicePlanComment(slicePlan) }] }),
          updateComment,
        },
      },
    } as never;
    return basePorts({ octokit, events: () => events as never });
  }

  const recorded = (updateComment: ReturnType<typeof vi.fn>) => {
    const parsed = parseSlicePlanComment(updateComment.mock.calls[0][0].body);
    if (!parsed?.ok) throw new Error(JSON.stringify(parsed));
    return parsed.plan.slices[1];
  };

  it('threads the slice to SHIP, records pr-open with the PR number and reports it on the outcome', async () => {
    const updateComment = vi.fn().mockResolvedValue({ data: {} });
    vi.mocked(shipPhase).mockResolvedValue({ ok: true, prNumber: 55 });
    const outcome = await runIssue(baseRequest({ sizeGateMode: 'slice' }), basePolicy(), sliceSetup(updateComment));

    expect(vi.mocked(shipPhase).mock.calls[0][0].slice).toEqual({ index: 2, count: 3 });
    expect(recorded(updateComment)).toMatchObject({ index: 2, state: 'pr-open', prNumber: 55 });
    expect(outcome).toMatchObject({ state: 'ready', prNumber: 55, slice: { index: 2, count: 3 } });
  });

  it('records the slice as merged when SHIP found it already delivered', async () => {
    const updateComment = vi.fn().mockResolvedValue({ data: {} });
    vi.mocked(shipPhase).mockResolvedValue({ ok: true, prNumber: 55, alreadyDelivered: true });
    await runIssue(baseRequest({ sizeGateMode: 'slice' }), basePolicy(), sliceSetup(updateComment));

    expect(recorded(updateComment)).toMatchObject({ index: 2, state: 'merged', prNumber: 55 });
  });

  it('parks with fail naming the PR when recording it in the slice plan comment fails', async () => {
    const updateComment = vi.fn().mockRejectedValue(new Error('boom'));
    vi.mocked(shipPhase).mockResolvedValue({ ok: true, prNumber: 55 });
    const events = vi.fn();
    const outcome = await runIssue(
      baseRequest({ sizeGateMode: 'slice' }),
      basePolicy(),
      sliceSetup(updateComment, events),
    );

    expect(outcome).toMatchObject({ state: 'parked', reason: 'fail' });
    expect(events).toHaveBeenCalledWith('fail', expect.stringContaining('PR #55'), undefined);
  });

  it('skips the comment write when SHIP returns no PR number', async () => {
    const updateComment = vi.fn().mockResolvedValue({ data: {} });
    vi.mocked(shipPhase).mockResolvedValue({ ok: true, alreadyDelivered: true });
    const outcome = await runIssue(baseRequest({ sizeGateMode: 'slice' }), basePolicy(), sliceSetup(updateComment));

    expect(updateComment).not.toHaveBeenCalled();
    expect(outcome.state).toBe('ready');
  });

  it('leaves a non-slice run without slice on SHIP or the outcome', async () => {
    const outcome = await runIssue(baseRequest(), basePolicy(), basePorts());
    expect(vi.mocked(shipPhase).mock.calls[0][0].slice).toBeUndefined();
    expect(outcome).not.toHaveProperty('slice');
  });
});

describe('runIssue — invariant 2: budget asserted after each phase', () => {
  it('parks with reason fail when the budget is already exceeded after PLAN', async () => {
    const outcome = await runIssue(
      baseRequest(),
      basePolicy({ budget: { perIssueCapUsd: 1 } }),
      basePorts({ getIssueSpend: () => 2 }),
    );
    expect(outcome).toMatchObject({ state: 'parked', reason: 'fail' });
    expect(buildPhase).not.toHaveBeenCalled();
  });

  it('parks with reason fail when the budget is exceeded after BUILD', async () => {
    let spend = 0;
    vi.mocked(planPhase).mockImplementation(async () => {
      spend = 2;
      return PLAN_OK;
    });
    const outcome = await runIssue(
      baseRequest(),
      basePolicy({ budget: { perIssueCapUsd: 1 } }),
      basePorts({ getIssueSpend: () => spend }),
    );
    expect(outcome).toMatchObject({ state: 'parked', reason: 'fail' });
    expect(checkPhase).not.toHaveBeenCalled();
  });

  it('parks with reason fail when the budget is exceeded after CHECK', async () => {
    let spend = 0;
    vi.mocked(checkPhase).mockImplementation(async () => {
      spend = 2;
      return CHECK_OK;
    });
    const outcome = await runIssue(
      baseRequest(),
      basePolicy({ budget: { perIssueCapUsd: 1 } }),
      basePorts({ getIssueSpend: () => spend }),
    );
    expect(outcome).toMatchObject({ state: 'parked', reason: 'fail' });
    expect(shipPhase).not.toHaveBeenCalled();
  });

  it('reports the budget breach (not the check failure) when both occur after CHECK', async () => {
    let spend = 0;
    vi.mocked(checkPhase).mockImplementation(async () => {
      spend = 2;
      return { passed: false, summary: CHECK_SUMMARY, reworkRounds: 1, stuck: true };
    });
    const outcome = await runIssue(
      baseRequest(),
      basePolicy({ budget: { perIssueCapUsd: 1 } }),
      basePorts({ getIssueSpend: () => spend }),
    );
    expect(outcome).toMatchObject({ state: 'parked', reason: 'fail' });
    expect(shipPhase).not.toHaveBeenCalled();
  });

  it('never parks when no cap is configured, regardless of spend', async () => {
    const outcome = await runIssue(
      baseRequest(),
      basePolicy({ budget: {} }),
      basePorts({ getIssueSpend: () => 1_000_000 }),
    );
    expect(outcome.state).toBe('ready');
  });
});

describe('runIssue — invariant 3: environment released exactly once', () => {
  function trackedEnvironment(): { env: Environment; release: ReturnType<typeof vi.fn> } {
    const release = vi.fn().mockResolvedValue(undefined);
    const env: Environment = { port: 4100, env: () => ({}), recordPgid: () => {}, release };
    return { env, release };
  }

  it('releases once on a successful (ready) run', async () => {
    const { env, release } = trackedEnvironment();
    await runIssue(baseRequest(), basePolicy(), basePorts({ acquireEnvironment: async () => env }));
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('releases once when the run parks', async () => {
    const { env, release } = trackedEnvironment();
    vi.mocked(checkPhase).mockResolvedValue({ passed: false, summary: CHECK_SUMMARY, reworkRounds: 1 });
    await runIssue(baseRequest(), basePolicy(), basePorts({ acquireEnvironment: async () => env }));
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('releases once when the run escalates', async () => {
    const { env, release } = trackedEnvironment();
    vi.mocked(planPhase).mockResolvedValue({ ...PLAN_OK, ok: false, escalate: 'bad' });
    await runIssue(baseRequest(), basePolicy(), basePorts({ acquireEnvironment: async () => env }));
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('releases once when a phase throws unexpectedly', async () => {
    const { env, release } = trackedEnvironment();
    vi.mocked(buildPhase).mockRejectedValue(new Error('boom'));
    await runIssue(baseRequest(), basePolicy(), basePorts({ acquireEnvironment: async () => env }));
    expect(release).toHaveBeenCalledTimes(1);
  });
});

describe('runIssue — invariant 4: a failed lease degrades instead of parking', () => {
  it('logs environment_lease_failed and continues with appPort undefined', async () => {
    const events: Array<[string, string]> = [];
    const log = vi.fn((type: string, msg: string) => events.push([type, msg]));
    const outcome = await runIssue(
      baseRequest(),
      basePolicy(),
      basePorts({
        events: () => log,
        acquireEnvironment: async () => {
          throw new Error('port exhausted');
        },
      }),
    );

    expect(outcome.state).toBe('ready');
    expect(events).toContainEqual([
      'environment_lease_failed',
      'port lease unavailable (port exhausted) — running without injected PORT',
    ]);
    expect(vi.mocked(buildPhase).mock.calls[0][0].appPort).toBeUndefined();
  });

  it('does not attempt acquisition at all when the port is not injected', async () => {
    const outcome = await runIssue(baseRequest(), basePolicy(), basePorts());
    expect(outcome.state).toBe('ready');
    expect(vi.mocked(buildPhase).mock.calls[0][0].appPort).toBeUndefined();
  });
});

describe('runIssue — invariant 5: one terminal event sequence matching the outcome', () => {
  it('emits a single ready event for a successful run', async () => {
    const events: string[] = [];
    const log = vi.fn((type: string) => events.push(type));
    const outcome = await runIssue(baseRequest(), basePolicy(), basePorts({ events: () => log }));
    expect(outcome.state).toBe('ready');
    expect(
      events.filter((t) => ['ready', 'fail', 'escalate', 'held', 'conflict', 'ci-failed', 'timeout'].includes(t)),
    ).toEqual(['ready']);
  });

  it('emits a single fail event for a parked (check-failed) run', async () => {
    const events: string[] = [];
    const log = vi.fn((type: string) => events.push(type));
    vi.mocked(checkPhase).mockResolvedValue({ passed: false, summary: CHECK_SUMMARY, reworkRounds: 1 });
    const outcome = await runIssue(baseRequest(), basePolicy(), basePorts({ events: () => log }));
    expect(outcome).toMatchObject({ state: 'parked', reason: 'fail' });
    expect(events.filter((t) => ['ready', 'fail', 'escalate', 'held'].includes(t))).toEqual(['fail']);
  });

  it('emits a single escalate event for an escalated (plan) run', async () => {
    const events: string[] = [];
    const log = vi.fn((type: string) => events.push(type));
    vi.mocked(planPhase).mockResolvedValue({ ...PLAN_OK, ok: false, escalate: 'nope' });
    const outcome = await runIssue(baseRequest(), basePolicy(), basePorts({ events: () => log }));
    expect(outcome.state).toBe('escalated');
    expect(events.filter((t) => ['ready', 'fail', 'escalate', 'held'].includes(t))).toEqual(['escalate']);
  });
});

describe('runIssue — outcome mapping', () => {
  it('maps a passing run to ready with the PR number from SHIP', async () => {
    const outcome = await runIssue(baseRequest(), basePolicy(), basePorts());
    expect(outcome).toMatchObject({ state: 'ready', route: 'codex', branch: 'issue-1-fix-the-thing', prNumber: 42 });
  });

  it('skips SHIP and maps to ready (no prNumber) for a local-only run', async () => {
    const outcome = await runIssue(baseRequest({ localOnly: true }), basePolicy(), basePorts());
    expect(outcome).toMatchObject({ state: 'ready' });
    expect((outcome as { prNumber?: number }).prNumber).toBeUndefined();
    expect(shipPhase).not.toHaveBeenCalled();
  });

  it('maps a crossRunStuck CHECK result to parked/held', async () => {
    vi.mocked(checkPhase).mockResolvedValue({
      passed: false,
      summary: CHECK_SUMMARY,
      reworkRounds: 1,
      stuck: true,
      crossRunStuck: true,
    });
    const outcome = await runIssue(baseRequest(), basePolicy(), basePorts());
    expect(outcome).toMatchObject({ state: 'parked', reason: 'held' });
  });

  it('maps a stuck (non-cross-run) CHECK result to parked/escalate', async () => {
    vi.mocked(checkPhase).mockResolvedValue({ passed: false, summary: CHECK_SUMMARY, reworkRounds: 1, stuck: true });
    const outcome = await runIssue(baseRequest(), basePolicy(), basePorts());
    expect(outcome).toMatchObject({ state: 'parked', reason: 'escalate' });
  });

  it('maps a denied SHIP to parked/escalate', async () => {
    vi.mocked(shipPhase).mockResolvedValue({ ok: false, denied: true, deniedReason: 'no' });
    const outcome = await runIssue(baseRequest(), basePolicy(), basePorts());
    expect(outcome).toMatchObject({ state: 'parked', reason: 'escalate' });
  });

  it('maps a failed (non-denied) SHIP to parked/fail', async () => {
    vi.mocked(shipPhase).mockResolvedValue({ ok: false });
    const outcome = await runIssue(baseRequest(), basePolicy(), basePorts());
    expect(outcome).toMatchObject({ state: 'parked', reason: 'fail' });
  });

  it('lists remaining lens_review showstoppers in the CHECK parked message', async () => {
    const events: Array<[string, string]> = [];
    const log = vi.fn((type: string, message: string) => events.push([type, message]));
    const summary: CheckSummary = {
      failures: 1,
      passes: 0,
      skips: 0,
      total: 1,
      results: [
        {
          checker: 'lens_review',
          result: 'FAIL',
          details: 'src/a.ts:12 — s. Failure scenario: f (lenses: security)',
        },
      ],
    };
    vi.mocked(checkPhase).mockResolvedValue({
      passed: false,
      reworkRounds: 3,
      summary,
      failureSignature: 'lens_review:src/a.ts:12',
    });
    const outcome = await runIssue(baseRequest(), basePolicy(), basePorts({ events: () => log }));
    expect(outcome).toMatchObject({ state: 'parked', reason: 'fail' });
    const failMsg = events.find(([t, m]) => t === 'fail' && m.includes('remaining showstoppers'))?.[1];
    expect(failMsg).toContain('src/a.ts:12');
  });

  it("carries a failed SHIP's reason into the parked message", async () => {
    const events: Array<[string, string]> = [];
    const log = vi.fn((type: string, message: string) => events.push([type, message]));
    vi.mocked(shipPhase).mockResolvedValue({ ok: false, reason: 'worktree has merge conflicts in a.ts' });
    const outcome = await runIssue(baseRequest(), basePolicy(), basePorts({ events: () => log }));
    expect(outcome).toMatchObject({ state: 'parked', reason: 'fail' });
    expect(events).toContainEqual(['fail', 'ship phase failed: worktree has merge conflicts in a.ts']);
  });

  it('maps a BUILD escalation to escalated', async () => {
    vi.mocked(buildPhase).mockResolvedValue({ ok: false, model: 'm', route: 'codex', escalate: 'bad build' });
    const outcome = await runIssue(baseRequest(), basePolicy(), basePorts());
    expect(outcome).toMatchObject({ state: 'escalated', reason: 'build escalated: bad build' });
  });

  it('maps a no_diff BUILD result to parked/fail and never starts CHECK', async () => {
    vi.mocked(buildPhase).mockResolvedValue({ ok: false, model: 'm', route: 'codex', reason: 'no_diff' });
    const outcome = await runIssue(baseRequest(), basePolicy(), basePorts());
    expect(outcome).toMatchObject({ state: 'parked', reason: 'fail' });
    expect(checkPhase).not.toHaveBeenCalled();
  });

  it('maps a junk_only_diff BUILD result to parked/fail and never starts CHECK', async () => {
    vi.mocked(buildPhase).mockResolvedValue({ ok: false, model: 'm', route: 'codex', reason: 'junk_only_diff' });
    const outcome = await runIssue(baseRequest(), basePolicy(), basePorts());
    expect(outcome).toMatchObject({ state: 'parked', reason: 'fail' });
    expect(checkPhase).not.toHaveBeenCalled();
  });

  it('classifies an unexpected thrown error structurally via parkReasonFor', async () => {
    vi.mocked(buildPhase).mockRejectedValue(Object.assign(new Error('timed out'), { reason: 'timeout' }));
    const outcome = await runIssue(baseRequest(), basePolicy(), basePorts());
    expect(outcome).toMatchObject({ state: 'parked', reason: 'timeout' });
  });

  it('emits an environment warning when local_auth parks a run', async () => {
    const events: Array<[string, string]> = [];
    const log = vi.fn((type: string, message: string) => events.push([type, message]));
    vi.mocked(planPhase).mockRejectedValue(
      Object.assign(new Error('Failed to authenticate: OAuth session expired and could not be refreshed'), {
        reason: 'local_auth',
      }),
    );
    const outcome = await runIssue(baseRequest(), basePolicy(), basePorts({ events: () => log }));
    expect(outcome).toMatchObject({ state: 'parked', reason: 'fail' });
    const warnings = events.filter(([type]) => type === 'environment_warning');
    expect(warnings).toHaveLength(1);
    expect(warnings[0][1]).toContain('local_auth');
    expect(warnings[0][1]).toContain('factory doctor');
  });
});

describe('runIssue — decomposition', () => {
  it('invokes onDecomposed and rethrows its signal instead of treating it as a park', async () => {
    vi.mocked(planPhase).mockResolvedValue({ ...PLAN_OK, ok: false, decomposed: { childIssues: [2, 3] } });
    const onDecomposed = vi.fn(() => {
      const err = new Error('decomposed') as Error & { childIssues: number[] };
      err.childIssues = [2, 3];
      throw err;
    });
    await expect(runIssue(baseRequest(), basePolicy(), basePorts({ onDecomposed }))).rejects.toThrow('decomposed');
    expect(onDecomposed).toHaveBeenCalledWith([2, 3]);
    expect(buildPhase).not.toHaveBeenCalled();
  });

  it('returns an escalated outcome when the decompose hook does not throw', async () => {
    vi.mocked(planPhase).mockResolvedValue({ ...PLAN_OK, ok: false, decomposed: { childIssues: [2] } });
    const outcome = await runIssue(baseRequest(), basePolicy(), basePorts({ onDecomposed: vi.fn() }));
    expect(outcome).toMatchObject({ state: 'escalated' });
  });
});

describe('runIssue — sliced whole issue (ADR-0147)', () => {
  it('returns an escalated outcome naming the slice plan and never builds', async () => {
    vi.mocked(planPhase).mockResolvedValue({ ...PLAN_OK, ok: false, escalate: 'x', sliced: { sliceCount: 3 } });
    const onDecomposed = vi.fn();
    const outcome = await runIssue(baseRequest(), basePolicy(), basePorts({ onDecomposed }));
    expect(outcome).toMatchObject({ state: 'escalated', reason: expect.stringMatching(/sliced into 3 slice/) });
    expect(buildPhase).not.toHaveBeenCalled();
    expect(onDecomposed).not.toHaveBeenCalled();
  });
});

describe('runIssue — steward-triggered event (#2086)', () => {
  const CHECK_EXHAUSTED: CheckPhaseResult = {
    passed: false,
    summary: { ...CHECK_SUMMARY, results: [{ checker: 'tests', result: 'FAIL', details: 'nope' }] },
    reworkRounds: 3,
    failureSignature: 'sig-1',
  };
  const stewardCalls = (log: ReturnType<typeof vi.fn>) => log.mock.calls.filter((c) => c[0] === 'steward-triggered');

  it('logs nothing when the steward is off or false', async () => {
    vi.mocked(checkPhase).mockResolvedValue(CHECK_EXHAUSTED);
    for (const req of [baseRequest(), baseRequest({ stewardEnabled: false })]) {
      const log = vi.fn();
      await runIssue(req, basePolicy(), basePorts({ events: () => log }));
      expect(stewardCalls(log)).toHaveLength(0);
    }
  });

  it('logs one steward-triggered event after the fail park when enabled', async () => {
    vi.mocked(checkPhase).mockResolvedValue(CHECK_EXHAUSTED);
    const log = vi.fn();
    await runIssue(baseRequest({ stewardEnabled: true }), basePolicy(), basePorts({ events: () => log }));
    const calls = stewardCalls(log);
    expect(calls).toHaveLength(1);
    expect(calls[0][2]).toEqual({ stewardTriggered: { trigger: 'check-exhausted', failureSignature: 'sig-1' } });
    const types = log.mock.calls.map((c) => c[0]);
    expect(types.indexOf('steward-triggered')).toBeGreaterThan(types.indexOf('fail'));
  });

  it('uses the ship-failed trigger for a ci-failed park', async () => {
    vi.mocked(shipPhase).mockRejectedValue(Object.assign(new Error('ci red'), { parkReason: 'ci-failed' }));
    const log = vi.fn();
    await runIssue(baseRequest({ stewardEnabled: true }), basePolicy(), basePorts({ events: () => log }));
    const calls = stewardCalls(log);
    expect(calls).toHaveLength(1);
    expect(calls[0][2].stewardTriggered.trigger).toBe('ship-failed');
  });

  it('logs nothing for non-trigger parks', async () => {
    const log = vi.fn();
    vi.mocked(checkPhase).mockResolvedValue({ ...CHECK_EXHAUSTED, reworkRounds: 1 });
    await runIssue(baseRequest({ stewardEnabled: true }), basePolicy(), basePorts({ events: () => log }));
    vi.mocked(checkPhase).mockResolvedValue(CHECK_OK);
    vi.mocked(buildPhase).mockResolvedValue({ ok: false, model: 'm', route: 'codex', reason: 'no_diff' });
    await runIssue(baseRequest({ stewardEnabled: true }), basePolicy(), basePorts({ events: () => log }));
    expect(stewardCalls(log)).toHaveLength(0);
  });

  it('leaves the park outcome and reports unchanged', async () => {
    vi.mocked(checkPhase).mockResolvedValue(CHECK_EXHAUSTED);
    const run = async (stewardEnabled: boolean) => {
      const writeLocalRunReport = vi.fn().mockResolvedValue('/tmp/report.md');
      const writeBenchmarkArtifacts = vi.fn().mockResolvedValue(undefined);
      const touched = vi.fn();
      const octokit: Octokit = new Proxy({} as Octokit, {
        get: (_target, prop) => {
          touched(prop);
          return undefined;
        },
      });
      const outcome = await runIssue(
        baseRequest({ stewardEnabled }),
        basePolicy(),
        basePorts({ writeLocalRunReport, writeBenchmarkArtifacts, octokit }),
      );
      return { outcome, writeLocalRunReport, writeBenchmarkArtifacts, touched };
    };
    const off = await run(false);
    const on = await run(true);
    expect(on.outcome).toEqual(off.outcome);
    expect(on.writeLocalRunReport.mock.calls).toEqual(off.writeLocalRunReport.mock.calls);
    expect(on.writeBenchmarkArtifacts.mock.calls).toEqual(off.writeBenchmarkArtifacts.mock.calls);
    expect(on.touched.mock.calls).toEqual(off.touched.mock.calls);
  });
});

describe('runIssue — steward park path (#2124)', () => {
  const CHECK_EXHAUSTED: CheckPhaseResult = {
    passed: false,
    summary: { ...CHECK_SUMMARY, results: [{ checker: 'tests', result: 'FAIL', details: 'nope' }] },
    reworkRounds: 3,
    failureSignature: 'sig-1',
  };
  let runDir: string;
  beforeEach(() => {
    runDir = mkdtempSync(join(tmpdir(), 'steward-park-'));
  });
  afterEach(() => {
    rmSync(runDir, { recursive: true, force: true });
  });

  const stewardRig = (order: string[] = []) => {
    const comments: StewardIssueComment[] = [];
    const client: StewardCommentGitHubClient = {
      listIssueComments: vi.fn(async () => comments.map((c) => ({ ...c }))),
      createIssueComment: vi.fn(async ({ body }) => {
        order.push('createIssueComment');
        comments.push({ id: comments.length + 1, body });
        return { id: comments.length };
      }),
      updateIssueComment: vi.fn(async () => {}),
    };
    const invoke = vi.fn(async () => {
      order.push('invoke');
      return {
        text: JSON.stringify({
          diagnosis: 'Stale fixture.',
          category: 'test',
          nextStep: 'Refresh it.',
          confidence: 0.95,
          citations: [{ field: 'issue', excerpt: 'Fix the thing' }],
        }),
      };
    });
    const steward: RunStewardPorts = { runDir, costsFile: join(runDir, 'costs.jsonl'), invoke, comments: client };
    return { comments, client, invoke, steward };
  };
  const stewardFiles = () => ['steward-packet.json', 'steward-verdict.json'].filter((f) => existsSync(join(runDir, f)));

  it('posts one comment for a stuck run and leaves the outcome unchanged', async () => {
    vi.mocked(checkPhase).mockResolvedValue(CHECK_EXHAUSTED);
    const off = await runIssue(baseRequest(), basePolicy(), basePorts());
    const rig = stewardRig();
    const on = await runIssue(baseRequest({ stewardEnabled: true }), basePolicy(), basePorts({ steward: rig.steward }));
    expect(rig.comments).toHaveLength(1);
    expect(rig.client.createIssueComment).toHaveBeenCalledWith(expect.objectContaining({ issue_number: 1 }));
    expect(on).toMatchObject({ state: 'parked', reason: 'fail', failureSignature: 'sig-1' });
    expect(on).toEqual(off);
  });

  it('finishes the steward before the park is reported', async () => {
    vi.mocked(checkPhase).mockResolvedValue(CHECK_EXHAUSTED);
    const order: string[] = [];
    const rig = stewardRig(order);
    const log = vi.fn((type: string) => {
      order.push(type);
    });
    await runIssue(
      baseRequest({ stewardEnabled: true }),
      basePolicy(),
      basePorts({
        events: () => log,
        steward: rig.steward,
        writeLocalRunReport: vi.fn(async () => {
          order.push('writeLocalRunReport');
          return '/tmp/report.md';
        }),
        writeBenchmarkArtifacts: vi.fn(async () => {
          order.push('writeBenchmarkArtifacts');
        }),
      }),
    );
    const at = (name: string) => order.indexOf(name);
    expect(at('fail')).toBeGreaterThanOrEqual(0);
    expect(at('fail')).toBeLessThan(at('steward-triggered'));
    expect(at('steward-triggered')).toBeLessThan(at('invoke'));
    expect(at('invoke')).toBeLessThan(at('createIssueComment'));
    expect(at('createIssueComment')).toBeLessThan(at('writeLocalRunReport'));
    expect(at('writeLocalRunReport')).toBeLessThan(at('writeBenchmarkArtifacts'));
    expect(rig.comments).toHaveLength(1);
  });

  it('is inert when the steward is disabled', async () => {
    vi.mocked(checkPhase).mockResolvedValue(CHECK_EXHAUSTED);
    for (const req of [baseRequest(), baseRequest({ stewardEnabled: false })]) {
      const rig = stewardRig();
      const log = vi.fn();
      const outcome = await runIssue(req, basePolicy(), basePorts({ events: () => log, steward: rig.steward }));
      expect(rig.invoke).not.toHaveBeenCalled();
      expect(rig.client.listIssueComments).not.toHaveBeenCalled();
      expect(rig.client.createIssueComment).not.toHaveBeenCalled();
      expect(stewardFiles()).toEqual([]);
      expect(log.mock.calls.filter((c) => c[0] === 'steward-triggered')).toHaveLength(0);
      expect(outcome).toMatchObject({ state: 'parked', reason: 'fail' });
    }
  });

  it('does not touch the steward on a healthy run', async () => {
    const rig = stewardRig();
    const log = vi.fn();
    await runIssue(
      baseRequest({ stewardEnabled: true }),
      basePolicy(),
      basePorts({ events: () => log, steward: rig.steward }),
    );
    expect(log.mock.calls.filter((c) => c[0] === 'steward-triggered')).toHaveLength(0);
    expect(rig.invoke).not.toHaveBeenCalled();
    expect(rig.client.createIssueComment).not.toHaveBeenCalled();
    expect(stewardFiles()).toEqual([]);
  });

  it('does not invoke the steward for a non-trigger park', async () => {
    vi.mocked(checkPhase).mockResolvedValue({ ...CHECK_EXHAUSTED, reworkRounds: 1 });
    const rig = stewardRig();
    await runIssue(baseRequest({ stewardEnabled: true }), basePolicy(), basePorts({ steward: rig.steward }));
    expect(rig.invoke).not.toHaveBeenCalled();
  });
});

describe('runIssue — reporting hooks', () => {
  it('writes a local run report and benchmark artifacts on every parked exit', async () => {
    vi.mocked(checkPhase).mockResolvedValue({ passed: false, summary: CHECK_SUMMARY, reworkRounds: 1 });
    const writeLocalRunReport = vi.fn().mockResolvedValue('/tmp/report.md');
    const writeBenchmarkArtifacts = vi.fn().mockResolvedValue(undefined);
    await runIssue(baseRequest(), basePolicy(), basePorts({ writeLocalRunReport, writeBenchmarkArtifacts }));
    expect(writeLocalRunReport).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed' }));
    expect(writeBenchmarkArtifacts).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'failed', reportPath: '/tmp/report.md' }),
    );
  });

  it('records and clears rework history around a passing CHECK', async () => {
    const reworkHistory = {
      priorSignature: vi.fn().mockResolvedValue(undefined),
      record: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
    };
    await runIssue(baseRequest(), basePolicy(), basePorts({ reworkHistory: reworkHistory as never }));
    expect(reworkHistory.priorSignature).toHaveBeenCalledWith(1);
    expect(reworkHistory.clear).toHaveBeenCalledWith(1);
    expect(reworkHistory.record).not.toHaveBeenCalled();
  });

  it('records rework history when CHECK fails with a failure signature', async () => {
    vi.mocked(checkPhase).mockResolvedValue({
      passed: false,
      summary: { ...CHECK_SUMMARY, results: [{ checker: 'tests', result: 'FAIL', details: 'nope' }] },
      reworkRounds: 1,
      failureSignature: 'sig-1',
    });
    const reworkHistory = {
      priorSignature: vi.fn().mockResolvedValue(undefined),
      record: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
    };
    await runIssue(baseRequest(), basePolicy(), basePorts({ reworkHistory: reworkHistory as never }));
    expect(reworkHistory.record).toHaveBeenCalledWith(1, 'sig-1', ['tests']);
    expect(reworkHistory.clear).not.toHaveBeenCalled();
  });

  it('carries the recorded failure signature and failing checks on the parked outcome (#1917)', async () => {
    vi.mocked(checkPhase).mockResolvedValue({
      passed: false,
      summary: { ...CHECK_SUMMARY, results: [{ checker: 'tests', result: 'FAIL', details: 'nope' }] },
      reworkRounds: 1,
      failureSignature: 'sig-1',
    });
    const reworkHistory = {
      priorSignature: vi.fn().mockResolvedValue(undefined),
      record: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
    };
    const outcome = await runIssue(baseRequest(), basePolicy(), basePorts({ reworkHistory: reworkHistory as never }));
    expect(outcome).toMatchObject({ state: 'parked', failureSignature: 'sig-1', failingChecks: ['tests'] });
    const parked = outcome as Extract<typeof outcome, { state: 'parked' }>;
    expect(reworkHistory.record).toHaveBeenCalledWith(1, parked.failureSignature, parked.failingChecks);
  });

  it('carries the signature on a held (cross-run stuck) CHECK park (#1917)', async () => {
    vi.mocked(checkPhase).mockResolvedValue({
      passed: false,
      summary: { ...CHECK_SUMMARY, results: [{ checker: 'tests', result: 'FAIL', details: 'nope' }] },
      reworkRounds: 0,
      failureSignature: 'sig-1',
      crossRunStuck: true,
      stuck: true,
    });
    const outcome = await runIssue(baseRequest(), basePolicy(), basePorts());
    expect(outcome).toMatchObject({ state: 'parked', reason: 'held', failureSignature: 'sig-1' });
  });

  it('logs checkFailure on a CHECK park event and none on a non-CHECK park (#2083)', async () => {
    vi.mocked(checkPhase).mockResolvedValue({
      passed: false,
      summary: { ...CHECK_SUMMARY, results: [{ checker: 'tests', result: 'FAIL', details: 'nope' }] },
      reworkRounds: 1,
      failureSignature: 'sig-1',
    });
    const log = vi.fn();
    await runIssue(baseRequest(), basePolicy(), basePorts({ events: () => log }));
    expect(log).toHaveBeenCalledWith('fail', expect.any(String), {
      checkFailure: { signature: 'sig-1', failingChecks: ['tests'] },
    });

    vi.mocked(buildPhase).mockResolvedValue({ ok: false, model: 'm', route: 'codex', reason: 'no_diff' });
    vi.mocked(checkPhase).mockReset();
    const buildLog = vi.fn();
    await runIssue(baseRequest(), basePolicy(), basePorts({ events: () => buildLog }));
    const parkCalls = buildLog.mock.calls.filter(([type]) => type === 'fail');
    expect(parkCalls.length).toBeGreaterThan(0);
    for (const call of parkCalls) expect(call[2]).toBeUndefined();
  });

  it('leaves the signature undefined on a non-CHECK park (#1917)', async () => {
    vi.mocked(buildPhase).mockResolvedValue({ ok: false, model: 'm', route: 'codex', reason: 'no_diff' });
    const outcome = await runIssue(baseRequest(), basePolicy(), basePorts());
    expect(outcome.state).toBe('parked');
    expect(outcome).not.toHaveProperty('failureSignature');
    expect(outcome).not.toHaveProperty('failingChecks');
  });
});

describe('runIssue — #1325: truthful phase snapshot', () => {
  it('records plan, build, check, ship in order for a full successful run', async () => {
    const recordPhase = vi.fn().mockResolvedValue(undefined);
    const outcome = await runIssue(baseRequest(), basePolicy(), basePorts({ recordPhase }));
    expect(outcome.state).toBe('ready');
    expect(recordPhase.mock.calls.map((call) => call[0])).toEqual(['plan', 'build', 'check', 'ship']);
  });

  it('stops recording after the phase where the run parks', async () => {
    vi.mocked(buildPhase).mockResolvedValue({ ok: false, model: 'm', route: 'codex', reason: 'no_diff' });
    const recordPhase = vi.fn().mockResolvedValue(undefined);
    await runIssue(baseRequest(), basePolicy(), basePorts({ recordPhase }));
    expect(recordPhase.mock.calls.map((call) => call[0])).toEqual(['plan', 'build']);
  });

  it('logs a phase_snapshot_failed event but does not fail the run when recordPhase rejects', async () => {
    const events: Array<[string, string]> = [];
    const log = vi.fn((type: string, message: string) => events.push([type, message]));
    const recordPhase = vi.fn().mockRejectedValue(new Error('disk full'));
    const outcome = await runIssue(baseRequest(), basePolicy(), basePorts({ recordPhase, events: () => log }));
    expect(outcome.state).toBe('ready');
    const failures = events.filter(([type]) => type === 'phase_snapshot_failed');
    expect(failures).toHaveLength(4);
    expect(failures[0][1]).toContain('disk full');
  });
});

describe('runIssue — #1326: activity heartbeat forwarded to CHECK', () => {
  it('forwards ports.onActivity to checkPhase verbatim', async () => {
    const onActivity = vi.fn().mockResolvedValue(undefined);
    await runIssue(baseRequest(), basePolicy(), basePorts({ onActivity }));

    expect(vi.mocked(checkPhase).mock.calls[0][0]).toMatchObject({ onActivity });
  });

  it('passes undefined through to checkPhase when no onActivity port is wired', async () => {
    await runIssue(baseRequest(), basePolicy(), basePorts());

    expect(vi.mocked(checkPhase).mock.calls[0][0]).toMatchObject({ onActivity: undefined });
  });
});

describe('runIssue — interactive steering, proxy, and pgid tracking', () => {
  it('drains steering during BUILD and logs steering_applied when messages are present', async () => {
    const events: Array<[string, string]> = [];
    const log = vi.fn((type: string, msg: string) => events.push([type, msg]));
    const drainSteering = vi.fn(() => ({
      messages: [{ id: 's1', issue: 1, text: 'do X', queuedAt: '2026-01-01T00:00:00.000Z' }],
      attachments: [],
    }));
    const outcome = await runIssue(
      baseRequest({ options: { interactive: true, autoRework: true, approvePlan: false, sandboxDisabled: false } }),
      basePolicy(),
      basePorts({ events: () => log, drainSteering }),
    );
    expect(outcome.state).toBe('ready');
    expect(drainSteering).toHaveBeenCalled();
    expect(events.some(([t, m]) => t === 'steering_applied' && m.includes('s1'))).toBe(true);
    expect(vi.mocked(buildPhase).mock.calls[0][0].steering?.messages).toEqual([
      { id: 's1', issue: 1, text: 'do X', queuedAt: '2026-01-01T00:00:00.000Z' },
    ]);
  });

  it('logs the resolved proxy note when resolveBaseUrl returns one', async () => {
    const events: Array<[string, string]> = [];
    const log = vi.fn((type: string, msg: string) => events.push([type, msg]));
    const resolveBaseUrl = vi.fn(() => ({ baseUrl: 'https://lane.example.test', note: 'stable lane URL' }));
    await runIssue(baseRequest(), basePolicy(), basePorts({ events: () => log, resolveBaseUrl }));
    expect(events).toContainEqual(['environment_proxy', 'stable lane URL']);
    expect(vi.mocked(buildPhase).mock.calls[0][0].appBaseUrl).toBe('https://lane.example.test');
  });

  it('tracks a pgid reported through onPgid in both the tracker and the environment', async () => {
    const recordPgid = vi.fn();
    const environment: Environment = {
      port: 4100,
      env: () => ({}),
      recordPgid,
      release: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(buildPhase).mockImplementation(async (opts) => {
      opts.onPgid?.(4321);
      return BUILD_OK;
    });
    const outcome = await runIssue(
      baseRequest(),
      basePolicy(),
      basePorts({ acquireEnvironment: async () => environment }),
    );
    expect(outcome.state).toBe('ready');
    expect(recordPgid).toHaveBeenCalledWith(4321);
  });
});

describe('runIssue — provider breaker and failover', () => {
  it('opens the breaker and logs provider_breaker_open when a phase reports a provider failure', async () => {
    const events: Array<[string, string]> = [];
    const log = vi.fn((type: string, msg: string) => events.push([type, msg]));
    vi.mocked(planPhase).mockImplementation(async (opts) => {
      await opts.onProviderFailure?.({ provider: 'anthropic', reason: 'usage_cap' });
      return PLAN_OK;
    });
    const breaker = new ProviderBreaker(join(breakerDir, 'breaker-provider-fail.json'));
    const outcome = await runIssue(baseRequest(), basePolicy(), basePorts({ events: () => log, breaker }));
    expect(outcome.state).toBe('ready');
    expect(events.some(([t, m]) => t === 'provider_breaker_open' && m.includes('anthropic'))).toBe(true);
    const status = await breaker.status('anthropic');
    expect(status.open).toBe(true);
  });

  it('honors a provider-reported reset time over the default cooldown', async () => {
    vi.mocked(planPhase).mockImplementation(async (opts) => {
      await opts.onProviderFailure?.({
        provider: 'anthropic',
        reason: 'usage_cap',
        detail: 'Resets in 3hr 17min.',
      });
      return PLAN_OK;
    });
    const breaker = new ProviderBreaker(join(breakerDir, 'breaker-reset-hint.json'));
    await runIssue(
      baseRequest({ failover: { enabled: false, cooldownMs: 999, fallbackModel: 'x' } }),
      basePolicy(),
      basePorts({ breaker }),
    );
    const status = await breaker.status('anthropic');
    expect(status.open).toBe(true);
    if (status.open) expect(status.remainingMs).toBeGreaterThan(3 * 60 * 60_000);
  });

  it('gates BUILD on an open codex breaker and reroutes a claude plan to its codex fallback', async () => {
    vi.mocked(planPhase).mockResolvedValue({ ...PLAN_OK, route: 'claude' });
    const breaker = new ProviderBreaker(join(breakerDir, 'breaker-gate.json'));
    await breaker.open('anthropic', 'usage_cap', 60_000);
    const router = fakeRouter({
      'claude-build': { provider: 'anthropic' },
      'gpt-build': { provider: 'openai', codex: true },
    });
    const request = baseRequest({
      failover: { enabled: true, cooldownMs: 60_000, fallbackModel: 'claude-sonnet-5' },
    });
    await runIssue(request, basePolicy(), basePorts({ breaker, router }));
    expect(vi.mocked(buildPhase).mock.calls[0][0]).toMatchObject({ route: 'codex', modelOverride: 'gpt-build' });
  });

  it('ignores an override model incompatible with an explicitly pinned route and logs model_override_ignored', async () => {
    const events: Array<[string, string]> = [];
    const log = vi.fn((type: string, msg: string) => events.push([type, msg]));
    const router = fakeRouter({ 'claude-only-model': { provider: 'anthropic' } });
    const request = baseRequest({ modelPins: { build: 'claude-only-model', sources: {} }, preferredRoute: 'codex' });
    await runIssue(request, basePolicy(), basePorts({ events: () => log, router }));
    expect(
      events.some(
        ([t, m]) =>
          t === 'model_override_ignored' &&
          m.includes('claude-only-model') &&
          m.includes('pinned by .factory/config.json'),
      ),
    ).toBe(true);
    expect(vi.mocked(buildPhase).mock.calls[0][0]).toMatchObject({ route: 'codex', modelOverride: undefined });
    expect(events.some(([t]) => t === 'model-override')).toBe(false);
  });
});

describe('runIssue — #1367: a pinned build model determines the build route', () => {
  it('keeps a claude-cli build pin on the claude route even when PLAN picks codex', async () => {
    const events: Array<[string, string]> = [];
    const log = vi.fn((type: string, msg: string) => events.push([type, msg]));
    vi.mocked(planPhase).mockResolvedValue({ ...PLAN_OK, route: 'codex' });
    const router = fakeRouter({ 'claude-sonnet-5': { provider: 'anthropic' } });
    const request = baseRequest({ modelPins: { build: 'claude-sonnet-5', sources: { build: 'repo' } } });
    await runIssue(request, basePolicy(), basePorts({ events: () => log, router }));

    expect(vi.mocked(planPhase).mock.calls[0][0].preferredRoute).toBe('claude');
    expect(vi.mocked(buildPhase).mock.calls[0][0]).toMatchObject({ route: 'claude', modelOverride: 'claude-sonnet-5' });
    expect(
      events.some(
        ([t, m]) => t === 'model-override' && m.includes('derived from pinned build model claude-sonnet-5 → claude'),
      ),
    ).toBe(true);
    expect(events.some(([t]) => t === 'model_override_ignored')).toBe(false);
  });

  it('keeps a codex build pin on the codex route even when PLAN picks claude', async () => {
    vi.mocked(planPhase).mockResolvedValue({ ...PLAN_OK, route: 'claude' });
    const router = fakeRouter({ 'gpt-build': { provider: 'openai', codex: true } });
    const request = baseRequest({ modelPins: { build: 'gpt-build', sources: { build: 'repo' } } });
    await runIssue(request, basePolicy(), basePorts({ router }));

    expect(vi.mocked(planPhase).mock.calls[0][0].preferredRoute).toBe('codex');
    expect(vi.mocked(buildPhase).mock.calls[0][0]).toMatchObject({ route: 'codex', modelOverride: 'gpt-build' });
  });

  it('does not let a codex pin force the codex route while codex is disabled', async () => {
    const events: Array<[string, string]> = [];
    const log = vi.fn((type: string, msg: string) => events.push([type, msg]));
    vi.mocked(planPhase).mockResolvedValue({ ...PLAN_OK, route: 'claude' });
    const router = fakeRouter({ 'gpt-build': { provider: 'openai', codex: true } });
    const request = baseRequest({ modelPins: { build: 'gpt-build', sources: { build: 'repo' } }, codexDisabled: true });
    await runIssue(request, basePolicy(), basePorts({ events: () => log, router }));

    expect(vi.mocked(planPhase).mock.calls[0][0].preferredRoute).toBeUndefined();
    expect(events.some(([t, m]) => t === 'model-override' && m.includes('codex is disabled'))).toBe(true);
    expect(events.some(([t, m]) => t === 'model-override' && m.includes('derived from'))).toBe(false);
    // PLAN's route stands and the codex pin is incompatible with it, as on main.
    expect(vi.mocked(buildPhase).mock.calls[0][0]).toMatchObject({
      route: 'claude',
      modelOverride: undefined,
      codexDisabled: true,
    });
    expect(events.some(([t]) => t === 'model_override_ignored')).toBe(true);
  });

  it('does not derive a route in local-only mode, where PLAN forces codex', async () => {
    vi.mocked(planPhase).mockResolvedValue({ ...PLAN_OK, route: 'codex' });
    const router = fakeRouter({ 'claude-sonnet-5': { provider: 'anthropic' } });
    const request = baseRequest({
      modelPins: { build: 'claude-sonnet-5', sources: { build: 'repo' } },
      localOnly: true,
    });
    await runIssue(request, basePolicy(), basePorts({ router }));

    expect(vi.mocked(planPhase).mock.calls[0][0].preferredRoute).toBeUndefined();
    expect(vi.mocked(buildPhase).mock.calls[0][0]).toMatchObject({ route: 'codex', modelOverride: undefined });
  });

  it('lets an explicit repo route win over the pin, and PLAN decide when nothing is pinned', async () => {
    vi.mocked(planPhase).mockResolvedValue({ ...PLAN_OK, route: 'claude' });
    const router = fakeRouter({ 'claude-sonnet-5': { provider: 'anthropic' } });
    await runIssue(
      baseRequest({ modelPins: { build: 'claude-sonnet-5', sources: {} }, preferredRoute: 'opencode' }),
      basePolicy(),
      basePorts({ router }),
    );
    expect(vi.mocked(planPhase).mock.calls[0][0].preferredRoute).toBe('opencode');
    expect(vi.mocked(buildPhase).mock.calls[0][0].route).toBe('opencode');

    vi.mocked(planPhase).mockClear();
    vi.mocked(buildPhase).mockClear();
    vi.mocked(planPhase).mockResolvedValue({ ...PLAN_OK, route: 'codex' });
    await runIssue(baseRequest(), basePolicy(), basePorts({ router }));
    expect(vi.mocked(planPhase).mock.calls[0][0].preferredRoute).toBeUndefined();
    expect(vi.mocked(buildPhase).mock.calls[0][0].route).toBe('codex');
  });
});

describe('runIssue — #1210: run-start diffBase captured once, before PLAN', () => {
  it('localOnly run threads one diffBase into every rework round', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'run-issue-diffbase-'));
    try {
      await execFile('git', ['init', '--initial-branch=main'], { cwd: worktree });
      await execFile('git', ['config', 'user.email', 'tests@example.com'], { cwd: worktree });
      await execFile('git', ['config', 'user.name', 'Tests'], { cwd: worktree });
      await writeFile(join(worktree, 'initial.txt'), 'initial\n');
      await execFile('git', ['add', '.'], { cwd: worktree });
      await execFile('git', ['commit', '-m', 'initial'], { cwd: worktree });
      const { stdout } = await execFile('git', ['rev-parse', 'HEAD'], { cwd: worktree });
      const runStartSha = stdout.trim();

      vi.mocked(planPhase).mockImplementation(async () => {
        await writeFile(join(worktree, 'plan.txt'), 'plan\n');
        await execFile('git', ['add', '.'], { cwd: worktree });
        await execFile('git', ['commit', '-m', 'plan'], { cwd: worktree });
        return PLAN_OK;
      });
      vi.mocked(buildPhase).mockImplementation(async () => {
        await writeFile(join(worktree, 'build.txt'), 'build\n');
        await execFile('git', ['add', '.'], { cwd: worktree });
        await execFile('git', ['commit', '-m', 'build'], { cwd: worktree });
        return { ...BUILD_OK, diffBase: undefined };
      });

      const writeBenchmarkArtifacts = vi.fn().mockResolvedValue(undefined);
      await runIssue(
        baseRequest({ localOnly: true }),
        basePolicy(),
        basePorts({ workspace: { path: worktree, dispose: async () => {} }, writeBenchmarkArtifacts }),
      );

      expect(vi.mocked(checkPhase).mock.calls[0][0].diffBase).toBe(runStartSha);
      expect(writeBenchmarkArtifacts).toHaveBeenCalledWith(expect.objectContaining({ diffBase: runStartSha }));
    } finally {
      await rm(worktree, { recursive: true, force: true });
    }
  });

  it('yields no diffBase, not a fabricated one, when the workspace is not a git checkout', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'run-issue-diffbase-nogit-'));
    try {
      await expect(
        runIssue(
          baseRequest({ localOnly: true }),
          basePolicy(),
          basePorts({ workspace: { path: worktree, dispose: async () => {} } }),
        ),
      ).resolves.toMatchObject({ state: 'ready' });

      expect(vi.mocked(checkPhase).mock.calls[0][0].diffBase).toBeUndefined();
    } finally {
      await rm(worktree, { recursive: true, force: true });
    }
  });
});

describe('runIssue — #1515: same-file lane guard', () => {
  async function tmpGuardFile(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'run-issue-lane-guard-'));
    return join(dir, 'lane-files.json');
  }

  function designTouching(file: string, via: 'targetTypes' | 'signatures'): DesignArtifact {
    return {
      restatedProblem: 'problem',
      approach: { chosen: 'chosen', rejected: [] },
      interfacesTouched: [],
      targetTypes: via === 'targetTypes' ? [{ name: 'Thing', file, kind: 'changed' }] : [],
      signatures: via === 'signatures' ? [{ symbol: 'thing', file, signature: '() => void' }] : [],
      callGraph: [],
      behaviorContract: [],
      verificationPlan: [],
      riskBlastRadius: 'low',
      openQuestions: [],
    };
  }

  it('parks the second run naming the colliding issue and file, while a disjoint third run is unaffected', async () => {
    const guard = new LaneFileGuard(await tmpGuardFile());

    let releaseBuildA: (() => void) | undefined;
    const buildABlocked = new Promise<void>((resolve) => {
      releaseBuildA = resolve;
    });

    vi.mocked(planPhase)
      .mockReset()
      .mockResolvedValueOnce({ ...PLAN_OK, designArtifact: designTouching('src/shared.ts', 'targetTypes') })
      .mockResolvedValueOnce({ ...PLAN_OK, designArtifact: designTouching('src/shared.ts', 'signatures') })
      .mockResolvedValueOnce({ ...PLAN_OK, designArtifact: designTouching('src/other.ts', 'targetTypes') });

    vi.mocked(buildPhase)
      .mockReset()
      .mockImplementationOnce(async () => {
        await buildABlocked;
        return BUILD_OK;
      })
      .mockResolvedValue(BUILD_OK);

    // Run A (#100) claims src/shared.ts and hangs in BUILD, simulating an in-flight lane
    // whose claim has not been released yet.
    const runA = runIssue(baseRequest({ issue: 100, repo: 'o/r' }), basePolicy(), basePorts({ laneFileGuard: guard }));
    await vi.waitFor(() => expect(vi.mocked(buildPhase)).toHaveBeenCalledTimes(1));

    const eventsB: Array<[string, string]> = [];
    const logB = vi.fn((type: string, msg: string) => eventsB.push([type, msg]));
    const outcomeB = await runIssue(
      baseRequest({ issue: 200, repo: 'o/r' }),
      basePolicy(),
      basePorts({ laneFileGuard: guard, events: () => logB }),
    );

    expect(outcomeB).toMatchObject({ state: 'parked', reason: 'held' });
    expect(
      eventsB.some(
        ([type, msg]) =>
          type === 'held' && msg.includes('#200') && msg.includes('#100') && msg.includes('src/shared.ts'),
      ),
    ).toBe(true);

    // Run C (#300) touches a disjoint file and is unaffected — reaches its stubbed BUILD.
    const outcomeC = await runIssue(
      baseRequest({ issue: 300, repo: 'o/r' }),
      basePolicy(),
      basePorts({ laneFileGuard: guard }),
    );
    expect(outcomeC.state).toBe('ready');
    expect(buildPhase).toHaveBeenCalledTimes(2);

    releaseBuildA?.();
    await expect(runA).resolves.toMatchObject({ state: 'ready' });
  });

  it('is a no-op when ports.laneFileGuard is left undefined, matching every caller that does not wire it', async () => {
    vi.mocked(planPhase).mockResolvedValue({
      ...PLAN_OK,
      designArtifact: designTouching('src/shared.ts', 'targetTypes'),
    });
    const outcome = await runIssue(baseRequest(), basePolicy(), basePorts());
    expect(outcome.state).toBe('ready');
    expect(buildPhase).toHaveBeenCalledTimes(1);
  });
});

describe('runIssue — PR classifier gate (#1724)', () => {
  const RULES = DEFAULT_REVIEW_FLOOR_RULES;
  const classifier = { rules: RULES, gateLabel: 'no-auto-merge' };

  function setup(opts: {
    changes?: { path: string; added: number; removed: number }[];
    readError?: Error;
    labelError?: Error;
  }) {
    const addLabels = vi.fn(async () => {
      if (opts.labelError) throw opts.labelError;
      return {};
    });
    const octokit = Object.assign({} as Octokit, { rest: { issues: { addLabels } } });
    const readReviewFloorChanges = vi.fn(async () => {
      if (opts.readError) throw opts.readError;
      return opts.changes ?? [];
    });
    const events: { kind: string; msg: string; extra?: any }[] = [];
    const classifyPr = vi.fn(async (): Promise<PrShadowVerdict> => verdict(null));
    const ports = basePorts({
      octokit,
      readReviewFloorChanges,
      classifyPr,
      events: () => (kind: string, msg: string, extra?: any) => {
        events.push({ kind, msg, extra });
      },
    });
    return { addLabels, readReviewFloorChanges, classifyPr, events, ports };
  }

  function verdict(modelClass: 'A' | 'B' | 'C' | null, reason?: string): PrShadowVerdict {
    return {
      modelClass,
      floorClass: 'A',
      finalClass: 'A',
      model: 'm-1',
      promptVersion: 'classify-pr/v1',
      policyVersion: 'floor-0123456789ab',
      diffSha: 'f'.repeat(64),
      adrIds: ['ADR-0121'],
      costUsd: 0.01,
      claims: [{ text: 'c', citation: 'a.ts:1' }],
      unsupportedClaims: [],
      notInspected: ['tests'],
      droppedClaims: 0,
      ...(reason ? { reason } : {}),
    };
  }
  const classified = (events: { kind: string; msg: string; extra?: any }[]) =>
    events.filter((e) => e.kind === 'pr-classified');

  it('records the shadow verdict as one pr-classified event and hands it to ship', async () => {
    const t = setup({ changes: [{ path: 'docs/guide.md', added: 3, removed: 0 }] });
    t.classifyPr.mockResolvedValue(verdict('B'));
    await runIssue(baseRequest({ prClassifier: { ...classifier, modelPin: 'pin' } }), basePolicy(), t.ports);
    const [event] = classified(t.events);
    expect(classified(t.events)).toHaveLength(1);
    expect(event.extra.prClassification).toMatchObject({
      modelClass: 'B',
      floorClass: 'A',
      finalClass: 'A',
      model: 'm-1',
      promptVersion: 'classify-pr/v1',
      policyVersion: 'floor-0123456789ab',
      adrIds: ['ADR-0121'],
      notInspected: ['tests'],
    });
    expect(t.classifyPr).toHaveBeenCalledWith(expect.objectContaining({ modelPin: 'pin', floor: 'A' }));
    expect(vi.mocked(shipPhase).mock.calls[0][0].reviewRouting?.shadow?.modelClass).toBe('B');
  });

  it('never lets a model C change an A floor: no label, no merge-gated', async () => {
    const t = setup({ changes: [{ path: 'docs/guide.md', added: 3, removed: 0 }] });
    t.classifyPr.mockResolvedValue(verdict('C'));
    const outcome = await runIssue(baseRequest({ prClassifier: classifier }), basePolicy(), t.ports);
    expect(outcome.state).toBe('ready');
    expect(t.addLabels).not.toHaveBeenCalled();
    expect(gated(t.events)).toHaveLength(0);
    expect(vi.mocked(shipPhase).mock.calls[0][0].reviewRouting?.gated).toBe(false);
  });

  it('continues to ship when the model verdict is unavailable', async () => {
    const t = setup({ changes: [{ path: 'docs/guide.md', added: 3, removed: 0 }] });
    t.classifyPr.mockResolvedValue(verdict(null, 'classifier produced no JSON object'));
    const outcome = await runIssue(baseRequest({ prClassifier: classifier }), basePolicy(), t.ports);
    expect(outcome.state).toBe('ready');
    expect(classified(t.events)[0].msg).toContain('classifier produced no JSON object');
  });

  it('logs a null verdict and still ships when the classifier port rejects', async () => {
    const t = setup({ changes: [{ path: 'docs/guide.md', added: 3, removed: 0 }] });
    t.classifyPr.mockRejectedValue(new Error('port blew up'));
    const outcome = await runIssue(baseRequest({ prClassifier: classifier }), basePolicy(), t.ports);
    expect(outcome.state).toBe('ready');
    expect(classified(t.events)[0].extra.prClassification).toMatchObject({
      modelClass: null,
      reason: 'classifier error: port blew up',
    });
  });

  it('does not call the shadow classifier when the flag is off', async () => {
    const t = setup({ changes: [{ path: 'docs/guide.md', added: 3, removed: 0 }] });
    await runIssue(baseRequest(), basePolicy(), t.ports);
    expect(t.classifyPr).not.toHaveBeenCalled();
    expect(classified(t.events)).toHaveLength(0);
  });

  const gated = (events: { kind: string; msg: string }[]) => events.filter((e) => e.kind === 'merge-gated');

  it('is off by default: no git read, no label, no event, no routing passed to ship', async () => {
    const t = setup({ changes: [{ path: '.github/workflows/ci.yml', added: 1, removed: 0 }] });
    const outcome = await runIssue(baseRequest(), basePolicy(), t.ports);
    expect(outcome.state).toBe('ready');
    expect(t.readReviewFloorChanges).not.toHaveBeenCalled();
    expect(t.addLabels).not.toHaveBeenCalled();
    expect(gated(t.events)).toHaveLength(0);
    expect(vi.mocked(shipPhase).mock.calls[0][0].reviewRouting).toBeUndefined();
  });

  it('holds a C-floor PR: labels the issue and logs merge-gated, then still ships', async () => {
    const t = setup({ changes: [{ path: '.github/workflows/ci.yml', added: 1, removed: 0 }] });
    const outcome = await runIssue(baseRequest({ issue: 7, prClassifier: classifier }), basePolicy(), t.ports);
    expect(outcome.state).toBe('ready');
    expect(t.addLabels).toHaveBeenCalledWith({ owner: 'o', repo: 'r', issue_number: 7, labels: ['no-auto-merge'] });
    const [event] = gated(t.events);
    expect(event.msg).toContain('classifier:floor:C:');
    expect(event.msg).toContain('workflows');
  });

  it('lets an A-floor PR through untouched, and hands the receipt to ship', async () => {
    const t = setup({ changes: [{ path: 'docs/guide.md', added: 3, removed: 0 }] });
    await runIssue(baseRequest({ prClassifier: classifier }), basePolicy(), t.ports);
    expect(t.addLabels).not.toHaveBeenCalled();
    expect(gated(t.events)).toHaveLength(0);
    expect(vi.mocked(shipPhase).mock.calls[0][0].reviewRouting).toMatchObject({ floor: 'A', gated: false });
  });

  it('fails closed when the diff cannot be read', async () => {
    const t = setup({ readError: new Error('no base ref') });
    await runIssue(baseRequest({ prClassifier: classifier }), basePolicy(), t.ports);
    expect(t.addLabels).toHaveBeenCalledTimes(1);
    expect(gated(t.events)[0].msg.startsWith('classifier:error')).toBe(true);
  });

  it('passes the floor and fired rules to ship as the receipt', async () => {
    const t = setup({ changes: [{ path: '.github/workflows/ci.yml', added: 1, removed: 0 }] });
    await runIssue(baseRequest({ prClassifier: classifier }), basePolicy(), t.ports);
    const routing = vi.mocked(shipPhase).mock.calls[0][0].reviewRouting;
    expect(routing?.floor).toBe('C');
    expect(routing?.rules.map((r) => r.id)).toContain('workflows');
  });

  it('parks held and never ships when the gate label cannot be applied', async () => {
    const t = setup({
      changes: [{ path: '.github/workflows/ci.yml', added: 1, removed: 0 }],
      labelError: new Error('403'),
    });
    const outcome = await runIssue(baseRequest({ prClassifier: classifier }), basePolicy(), t.ports);
    expect(outcome).toMatchObject({ state: 'parked', reason: 'held' });
    expect(shipPhase).not.toHaveBeenCalled();
  });

  it('never runs for a local-only run', async () => {
    const t = setup({ changes: [{ path: '.github/workflows/ci.yml', added: 1, removed: 0 }] });
    await runIssue(baseRequest({ localOnly: true, prClassifier: classifier }), basePolicy(), t.ports);
    expect(t.readReviewFloorChanges).not.toHaveBeenCalled();
    expect(t.addLabels).not.toHaveBeenCalled();
  });
});

describe('runIssue — environment release (#1928)', () => {
  const ENV = {
    baseSha: 'abc1234567890def',
    failingChecks: ['tests', 'lint'],
    logPaths: ['/logs/a.log', '/logs/check-base'],
  };
  const arrange = (request: Partial<RunRequest> = {}, createComment = vi.fn().mockResolvedValue({})) => {
    vi.mocked(checkPhase).mockResolvedValue({
      passed: false,
      summary: CHECK_SUMMARY,
      reworkRounds: 0,
      environment: ENV,
      failureSignature: 'sig',
    });
    const log = vi.fn();
    const reworkHistory = {
      priorSignature: vi.fn().mockResolvedValue(undefined),
      record: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
    };
    const ports = basePorts({
      events: () => log,
      octokit: { rest: { issues: { createComment } } } as never,
      reworkHistory: reworkHistory as never,
    });
    return { log, createComment, reworkHistory, run: () => runIssue(baseRequest(request), basePolicy(), ports) };
  };
  const kinds = (log: ReturnType<typeof vi.fn>) => log.mock.calls.map((c) => c[0]);

  it('returns a released outcome, posts one comment and emits environment-released', async () => {
    const { run, log, createComment, reworkHistory } = arrange();
    const outcome = await run();
    expect(outcome).toMatchObject({
      state: 'released',
      reason: 'environment',
      reworkRounds: 0,
      baseSha: ENV.baseSha,
      failingChecks: ENV.failingChecks,
      failureSignature: 'sig',
    });
    expect(createComment).toHaveBeenCalledTimes(1);
    const body = createComment.mock.calls[0][0].body as string;
    for (const needle of ['tests', 'lint', ENV.baseSha, '/logs/a.log', '/logs/check-base']) {
      expect(body).toContain(needle);
    }
    expect(kinds(log)).toContain('environment-released');
    for (const parkKind of ['fail', 'escalate', 'held']) expect(kinds(log)).not.toContain(parkKind);
    expect(reworkHistory.record).not.toHaveBeenCalled();
  });

  it('posts no comment on a local-only run', async () => {
    const { run, createComment } = arrange({ localOnly: true });
    expect(await run()).toMatchObject({ state: 'released' });
    expect(createComment).not.toHaveBeenCalled();
  });

  it('logs environment_warning and still releases when the comment fails', async () => {
    const { run, log } = arrange({}, vi.fn().mockRejectedValue(new Error('403')));
    expect(await run()).toMatchObject({ state: 'released' });
    expect(kinds(log)).toContain('environment_warning');
  });
});

describe('runIssue — flaky_tests event (#2302)', () => {
  const ENV = { baseSha: 'abc1234567890def', failingChecks: ['tests'], logPaths: [] as string[] };
  const baseline = { baseSha: 'abc1234567', checkers: [] };
  const arrange = (check: CheckPhaseResult) => {
    vi.mocked(checkPhase).mockResolvedValue(check);
    const log = vi.fn();
    const ports = basePorts({
      events: () => log,
      octokit: { rest: { issues: { createComment: vi.fn().mockResolvedValue({}) } } } as never,
    });
    return { log, run: () => runIssue(baseRequest(), basePolicy(), ports) };
  };
  const flakyCalls = (log: ReturnType<typeof vi.fn>) => log.mock.calls.filter((c) => c[0] === 'flaky_tests');
  const envResult = (flakeRerun?: CheckPhaseResult['flakeRerun'], withBaseline = true): CheckPhaseResult => ({
    passed: false,
    summary: CHECK_SUMMARY,
    reworkRounds: 0,
    environment: ENV,
    failureSignature: 'sig',
    ...(withBaseline ? { baseline } : {}),
    ...(flakeRerun ? { flakeRerun } : {}),
  });

  it('records a passed verdict and continues', async () => {
    const { log, run } = arrange({
      ...CHECK_OK,
      baseline,
      flakeRerun: { verdict: 'passed', mode: 'targeted', tests: ['adds'], logPath: '/l/flaky-rerun-tests.log' },
    });
    const outcome = await run();
    expect(flakyCalls(log)).toHaveLength(1);
    expect(flakyCalls(log)[0]?.[2]).toEqual({
      flakyTests: {
        sha: 'abc1234567',
        checker: 'tests',
        mode: 'targeted',
        tests: ['adds'],
        verdict: 'passed',
        logPath: '/l/flaky-rerun-tests.log',
      },
    });
    expect(outcome.state).not.toBe('parked');
    expect(outcome.state).not.toBe('released');
  });

  it('records a reproduced verdict and still releases', async () => {
    const { log, run } = arrange(envResult({ verdict: 'reproduced', mode: 'full', tests: [] }));
    const outcome = await run();
    expect(outcome).toMatchObject({ state: 'released', reason: 'environment' });
    expect(flakyCalls(log)).toHaveLength(1);
    const payload = flakyCalls(log)[0]?.[2].flakyTests;
    expect(payload).toMatchObject({ verdict: 'reproduced', mode: 'full', tests: [] });
    expect(payload).not.toHaveProperty('logPath');
  });

  it('records nothing for not-run', async () => {
    const { log, run } = arrange(envResult({ verdict: 'not-run', mode: 'full', tests: [] }));
    expect(await run()).toMatchObject({ state: 'released', reason: 'environment' });
    expect(flakyCalls(log)).toHaveLength(0);
  });

  it('records nothing without a baseline', async () => {
    const { log, run } = arrange(envResult({ verdict: 'passed', mode: 'full', tests: [] }, false));
    await run();
    expect(flakyCalls(log)).toHaveLength(0);
  });
});

describe('runIssue — flaky ledger and issue filing (#2303)', () => {
  const baseline = { baseSha: 'abc1234567890def', checkers: [] };
  let dir: string;
  let ledger: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'factory-flaky-run-'));
    ledger = join(dir, 'state', 'flaky-tests.json');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const seed = (runs: string[], issue: number | null = null) =>
    mkdir(join(dir, 'state'), { recursive: true }).then(() =>
      writeFile(ledger, JSON.stringify({ adds: { runs, lastSeen: '2026-01-01T00:00:00.000Z', issue } })),
    );
  const readLedger = async () =>
    JSON.parse(await readFile(ledger, 'utf-8')) as Record<string, { runs: string[]; issue: number | null }>;
  const flake = (over: Partial<NonNullable<CheckPhaseResult['flakeRerun']>> = {}): CheckPhaseResult => ({
    ...CHECK_OK,
    baseline,
    flakeRerun: { verdict: 'passed', mode: 'targeted', tests: ['adds'], logPath: '/l/flaky-rerun-tests.log', ...over },
  });
  const arrange = (
    check: CheckPhaseResult,
    req: Partial<RunRequest> = {},
    create = vi.fn().mockResolvedValue({ data: { number: 77 } }),
    createComment = vi.fn().mockResolvedValue({}),
  ) => {
    vi.mocked(checkPhase).mockResolvedValue(check);
    const log = vi.fn();
    const ports = basePorts({ events: () => log, octokit: { rest: { issues: { create, createComment } } } as never });
    return {
      log,
      create,
      createComment,
      run: () => runIssue(baseRequest({ flakyLedgerPath: ledger, issue: 9, ...req }), basePolicy(), ports),
    };
  };
  const messages = (log: ReturnType<typeof vi.fn>, kind: string) =>
    log.mock.calls.filter((c) => c[0] === kind).map((c) => String(c[1]));

  it('does not file below the threshold', async () => {
    await seed(['1@abcdef12']);
    const { run, create, createComment } = arrange(flake());
    await run();
    expect((await readLedger()).adds).toMatchObject({ runs: ['1@abcdef12', '9@abc12345'] });
    expect(create).not.toHaveBeenCalled();
    expect(createComment).not.toHaveBeenCalled();
  });

  it('creates one issue at 3 runs and stores its number', async () => {
    await seed(['1@abcdef12', '2@abcdef12']);
    const { run, create, createComment } = arrange(flake());
    await run();
    expect(create).toHaveBeenCalledTimes(1);
    const arg = create.mock.calls[0]?.[0];
    expect(arg).toMatchObject({ title: 'flaky: adds', labels: ['bug', 'testing'] });
    expect(arg.body).toContain('abc12345');
    expect(arg.body).toContain('#1 on base abcdef12');
    expect(arg.body).toContain('/l/flaky-rerun-tests.log');
    expect((await readLedger()).adds).toMatchObject({ issue: 77 });
    expect(createComment).not.toHaveBeenCalled();
  });

  it('comments on the stored issue once filed', async () => {
    await seed(['1@abcdef12', '2@abcdef12'], 55);
    const { run, create, createComment } = arrange(flake());
    await run();
    expect(createComment).toHaveBeenCalledTimes(1);
    expect(createComment.mock.calls[0]?.[0]).toMatchObject({ issue_number: 55 });
    expect(create).not.toHaveBeenCalled();
  });

  it('formats a run key without an @ as-is and omits the log path when absent', async () => {
    await seed(['legacy', '2@abcdef12']);
    const { run, create } = arrange(flake({ logPath: undefined }));
    await run();
    const body = create.mock.calls[0]?.[0].body as string;
    expect(body).toContain('- legacy');
    expect(body).not.toContain('Re-run log');
  });

  it('comment omits the log path when absent', async () => {
    await seed(['1@abcdef12', '2@abcdef12'], 55);
    const { run, createComment } = arrange(flake({ logPath: undefined }));
    await run();
    expect(createComment.mock.calls[0]?.[0].body).not.toContain('Re-run log');
  });

  it('localOnly updates the ledger but makes no octokit call', async () => {
    await seed(['1@abcdef12', '2@abcdef12']);
    const { run, create, createComment, log } = arrange(flake(), { localOnly: true });
    await run();
    expect(create).not.toHaveBeenCalled();
    expect(createComment).not.toHaveBeenCalled();
    expect((await readLedger()).adds).toMatchObject({ issue: null });
    expect((await readLedger()).adds.runs).toHaveLength(3);
    expect(messages(log, 'flaky_tests').some((m) => m.includes('local-only'))).toBe(true);
  });

  it('logs and continues when issues.create rejects', async () => {
    await seed(['1@abcdef12', '2@abcdef12']);
    const { run, log } = arrange(flake(), {}, vi.fn().mockRejectedValue(new Error('boom')));
    const outcome = await run();
    expect(outcome.state).not.toBe('parked');
    expect(outcome.state).not.toBe('released');
    expect(messages(log, 'environment_warning').some((m) => m.includes('boom'))).toBe(true);
    expect((await readLedger()).adds).toMatchObject({ issue: null });
  });

  it('logs and continues when issues.createComment rejects', async () => {
    await seed(['1@abcdef12', '2@abcdef12'], 55);
    const { run, log } = arrange(flake(), {}, undefined, vi.fn().mockRejectedValue(new Error('nope')));
    const outcome = await run();
    expect(outcome.state).not.toBe('parked');
    expect(messages(log, 'environment_warning').some((m) => m.includes('nope'))).toBe(true);
  });

  it('logs and files nothing when the ledger cannot be written', async () => {
    const blocker = join(dir, 'blocker');
    await writeFile(blocker, 'x');
    const { run, log, create, createComment } = arrange(flake(), { flakyLedgerPath: join(blocker, 'f.json') });
    const outcome = await run();
    expect(outcome.state).not.toBe('parked');
    expect(messages(log, 'environment_warning').some((m) => m.includes('flaky-test ledger'))).toBe(true);
    expect(create).not.toHaveBeenCalled();
    expect(createComment).not.toHaveBeenCalled();
  });

  it('records nothing without a ledger path, for reproduced, or for full mode without names', async () => {
    await arrange(flake(), { flakyLedgerPath: undefined }).run();
    await arrange({
      passed: false,
      summary: CHECK_SUMMARY,
      reworkRounds: 0,
      baseline,
      flakeRerun: { verdict: 'reproduced', mode: 'targeted', tests: ['adds'] },
    }).run();
    await arrange(flake({ mode: 'full', tests: [] })).run();
    expect(existsSync(ledger)).toBe(false);
  });
});
