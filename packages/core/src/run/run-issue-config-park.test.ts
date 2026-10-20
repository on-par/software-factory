import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Octokit } from '@octokit/rest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import type { BuildResult, buildPhase as realBuildPhase } from '../phases/build.js';
import type { CheckPhaseResult, checkPhase as realCheckPhase } from '../phases/check.js';
import type { PlanResult, planPhase as realPlanPhase } from '../phases/plan.js';
import type { ShipResult, shipPhase as realShipPhase } from '../phases/ship.js';
import { schemaErrorCheckerOutput } from '../checkers/index.js';
import { ProviderBreaker } from '../router/breaker.js';
import { ModelRouter } from '../router/index.js';
import type { Constitution } from '../types/index.js';
import type { WorkRequest } from '../work/index.js';
import { runIssue, type RunPorts, type RunRequest } from './run-issue.js';
import type { RunPolicy } from './policy.js';
import type { Workspace } from './ports.js';

const PLAN_OK: PlanResult = { ok: true, route: 'codex', specPath: '/tmp/wt/spec.md', model: 'm', designArtifact: null };
const BUILD_OK: BuildResult = { ok: true, model: 'm', route: 'codex' };
const CHECK_OK: CheckPhaseResult = {
  passed: true,
  summary: { failures: 0, passes: 1, skips: 0, total: 1, results: [] },
  reworkRounds: 0,
};
const SHIP_OK: ShipResult = { ok: true, prNumber: 42 };
const WORK: WorkRequest = {
  id: 'github-issue:o/r#1',
  kind: 'github-issue',
  title: 'Fix the thing',
  brief: 'do it',
  acceptanceCriteria: [],
};
const ROUTES: RoutesConfig = {
  version: 1,
  routes: {
    build_claude: { tier: 'worker', description: 'stub', requires: 'claude' },
    build_codex: { tier: 'worker', description: 'stub', requires: 'codex' },
  },
};
const MODELS: ModelsConfig = {
  version: 1,
  models: {},
  tiers: { worker: [] },
  failover: { triggers: [], maxRetries: 0, cooldownMs: 0, escalateAfterTierExhausted: false },
  routingRules: {},
};
const planPhase = vi.fn<typeof realPlanPhase>();
const buildPhase = vi.fn<typeof realBuildPhase>();
const checkPhase = vi.fn<typeof realCheckPhase>();
const shipPhase = vi.fn<typeof realShipPhase>();
const request = (): RunRequest => ({
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
});
const policy = (): RunPolicy => ({
  models: MODELS,
  routes: ROUTES,
  sandbox: {
    enabled: false,
    runtime: 'auto',
    codexFullAccessTasks: [],
    network: { allow: [] },
    resources: { cpuMs: 0, memMb: 0 },
    docker: { rolloutPercent: 0 },
  },
  budget: {},
  effective: {} as RunPolicy['effective'],
});
const tempDirs = new Set<string>();
let breakerIndex = 0;
const ports = (overrides: Partial<RunPorts> = {}): RunPorts => {
  const dir = mkdtempSync(join(tmpdir(), 'config-park-breaker-'));
  tempDirs.add(dir);
  return {
    router: new ModelRouter(MODELS, ROUTES),
    octokit: {} as Octokit,
    workspace: { path: '/tmp/wt', dispose: async () => {} } as Workspace,
    events: () => vi.fn(),
    breaker: new ProviderBreaker(join(dir, `breaker-${breakerIndex++}.json`)),
    resolveConstitution: () => null,
    planPhase,
    buildPhase,
    checkPhase,
    shipPhase,
    ...overrides,
  };
};

beforeEach(() => {
  vi.mocked(planPhase).mockReset().mockResolvedValue(PLAN_OK);
  vi.mocked(buildPhase).mockReset().mockResolvedValue(BUILD_OK);
  vi.mocked(checkPhase).mockReset().mockResolvedValue(CHECK_OK);
  vi.mocked(shipPhase).mockReset().mockResolvedValue(SHIP_OK);
});
afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

describe('runIssue — config failure parks (#2583)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'config-park-'));
    tempDirs.add(dir);
  });

  const arrange = (cause: 'config' | 'environment') => {
    const absPath = join(dir, 'constitution.md');
    writeFileSync(absPath, '---\nproduct: acme\nchecklist: x\ncheckers:\n  - tests\n---\nbody\n');
    const constitution: Constitution = {
      source: 'repo',
      product: 'acme',
      version: 1,
      checkers: ['tests'],
      body: 'body',
      path: absPath,
      requireTests: true,
      repoInstance: { relPath: '.factory/constitution.md', absPath },
    };
    vi.mocked(checkPhase).mockResolvedValue({
      passed: false,
      summary: {
        failures: 1,
        passes: 0,
        skips: 0,
        total: 1,
        results: [schemaErrorCheckerOutput('checkers[0]', 'entry 0 is a number')],
      },
      reworkRounds: 0,
      failureSignature: 'sig',
      environment: { baseSha: 'abc1234567890def', failingChecks: ['checkers[0]'], cause, logPaths: [] },
    });
    const log = vi.fn();
    const createComment = vi.fn().mockResolvedValue({});
    const store = () => ({
      load: vi.fn().mockResolvedValue(null),
      record: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
    });
    const checkResume = store();
    const planReuse = store();
    return {
      log,
      createComment,
      checkResume,
      planReuse,
      run: () =>
        runIssue(
          request(),
          policy(),
          ports({
            events: () => log,
            octokit: { rest: { issues: { createComment } } } as never,
            resolveConstitution: () => constitution,
            checkResume,
            planReuse,
          }),
        ),
    };
  };
  const kinds = (log: ReturnType<typeof vi.fn>) => log.mock.calls.map((call) => call[0]);

  it('parks a config-caused CHECK failure with event kind and park reason config (#2584)', async () => {
    const { run, log, createComment, checkResume, planReuse } = arrange('config');
    const outcome = await run();
    expect(outcome).toMatchObject({ state: 'parked', reason: 'config', failureSignature: 'sig' });
    expect(outcome.state).not.toBe('released');
    const fail = log.mock.calls.find((call) => call[0] === 'config');
    expect(fail?.[1]).toContain('.factory/constitution.md:4');
    expect(fail?.[1]).toContain('expected a list of checker names');
    expect(fail?.[1]).toContain('factory unpark');
    expect(kinds(log)).not.toContain('environment-released');
    expect(kinds(log)).not.toContain('fail');
    expect(createComment).not.toHaveBeenCalled();
    expect(checkResume.record).not.toHaveBeenCalled();
    expect(planReuse.record).not.toHaveBeenCalled();
  });

  it('still releases an environment-caused CHECK failure to queued', async () => {
    const { run, log } = arrange('environment');
    expect(await run()).toMatchObject({ state: 'released', reason: 'environment' });
    expect(kinds(log)).toContain('environment-released');
    expect(kinds(log)).not.toContain('fail');
  });
});
