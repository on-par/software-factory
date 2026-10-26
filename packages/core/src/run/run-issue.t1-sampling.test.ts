import { join } from 'node:path';

import type { Octokit } from '@octokit/rest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import type { BuildResult, buildPhase as realBuildPhase } from '../phases/build.js';
import type { CheckPhaseResult, checkPhase as realCheckPhase } from '../phases/check.js';
import type { PlanResult, planPhase as realPlanPhase } from '../phases/plan.js';
import type { ShipResult, shipPhase as realShipPhase } from '../phases/ship.js';
import { DEFAULT_REVIEW_FLOOR_RULES } from '../review/floor.js';
import { t1SampleValue } from '../review/routing.js';
import { ProviderBreaker } from '../router/breaker.js';
import { ModelRouter } from '../router/index.js';
import { createTempDirs } from '../harness/temp-dir.js';
import type { WorkRequest } from '../work/index.js';
import type { RunPolicy } from './policy.js';
import type { Workspace } from './ports.js';
import { runIssue, type RunPorts, type RunRequest } from './run-issue.js';

const planPhase = vi.fn<typeof realPlanPhase>();
const buildPhase = vi.fn<typeof realBuildPhase>();
const checkPhase = vi.fn<typeof realCheckPhase>();
const shipPhase = vi.fn<typeof realShipPhase>();

const PLAN_OK: PlanResult = { ok: true, route: 'codex', specPath: '/tmp/wt/spec.md', model: 'm', designArtifact: null };
const BUILD_OK: BuildResult = { ok: true, model: 'm', route: 'codex' };
const CHECK_OK: CheckPhaseResult = {
  passed: true,
  summary: { failures: 0, passes: 1, skips: 0, total: 1, results: [] },
  reworkRounds: 0,
};
const SHIP_OK: ShipResult = { ok: true, prNumber: 42 };

const tempDirs = createTempDirs();
const tmp = tempDirs.makeSync('run-issue-t1-sampling-');
afterAll(() => tempDirs.cleanup());

const ROUTES: RoutesConfig = { version: 1, routes: {} };
const MODELS: ModelsConfig = {
  version: 1,
  models: {},
  tiers: {},
  failover: { triggers: [], maxRetries: 0, cooldownMs: 0 },
  routingRules: {},
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

const RATE = 0.25;
/** First issue number whose sample value satisfies `pick`; the hash is fixed, so this is stable. */
function issueWhere(pick: (value: number) => boolean): number {
  for (let n = 1; n < 1000; n++) if (pick(t1SampleValue('o/r', n))) return n;
  throw new Error('no issue number found');
}
const SAMPLED = issueWhere((v) => v < RATE);
const UNSAMPLED = issueWhere((v) => v >= RATE);

function request(issue: number, prClassifier: NonNullable<RunRequest['prClassifier']>): RunRequest {
  const work: WorkRequest = {
    id: `github-issue:o/r#${issue}`,
    kind: 'github-issue',
    title: 'Fix the thing',
    brief: 'do the thing',
    acceptanceCriteria: [],
  };
  return {
    issue,
    repo: 'o/r',
    branch: `issue-${issue}-fix-the-thing`,
    specPath: '/tmp/wt/spec.md',
    work,
    startedAt: '2026-01-01T00:00:00.000Z',
    options: { interactive: false, autoRework: true, approvePlan: false, sandboxDisabled: false },
    timeouts: { plan: 60, build: 60, check: 60, approval: 60, tests: 60 },
    modelPins: { sources: {} },
    codexDisabled: false,
    skipCI: false,
    failover: { enabled: false, cooldownMs: 60_000, fallbackModel: 'claude-sonnet-5' },
    efficiency: { maxReworkRounds: 1, fastPath: false },
    processGroupGraceMs: 50,
    prClassifier,
  };
}

const classifier = {
  rules: DEFAULT_REVIEW_FLOOR_RULES,
  gateLabel: 'no-auto-merge',
  trustTier: 'T0' as const,
  t1SampleRate: 0.25,
};
const t1 = { ...classifier, trustTier: 'T1' as const, t1SampleRate: RATE };

function setup(path: string, labelError?: Error) {
  const addLabels = vi.fn(async () => {
    if (labelError) throw labelError;
    return {};
  });
  const octokit = Object.assign({} as Octokit, { rest: { issues: { addLabels } } });
  const events: { kind: string; msg: string }[] = [];
  const ports: RunPorts = {
    router: new ModelRouter(MODELS, ROUTES),
    octokit,
    workspace: { path: '/tmp/wt', dispose: async () => {} } as Workspace,
    events: () => (kind: string, msg: string) => {
      events.push({ kind, msg });
    },
    breaker: new ProviderBreaker(join(tmp, 'breaker.json')),
    resolveConstitution: () => null,
    planPhase,
    buildPhase,
    checkPhase,
    shipPhase,
    readReviewFloorChanges: async () => [{ path, added: 1, removed: 0 }],
  };
  const gated = () => events.filter((e) => e.kind === 'merge-gated');
  return { addLabels, ports, gated };
}

beforeEach(() => {
  planPhase.mockReset().mockResolvedValue(PLAN_OK);
  buildPhase.mockReset().mockResolvedValue(BUILD_OK);
  checkPhase.mockReset().mockResolvedValue(CHECK_OK);
  shipPhase.mockReset().mockResolvedValue(SHIP_OK);
});

describe('T1 sampling (#1958)', () => {
  it('holds a sampled A-floor PR: labels no-auto-merge and logs t1-sampled', async () => {
    const t = setup('docs/guide.md');
    const outcome = await runIssue(request(SAMPLED, t1), policy, t.ports);
    expect(outcome.state).toBe('ready');
    expect(t.addLabels).toHaveBeenCalledWith({
      owner: 'o',
      repo: 'r',
      issue_number: SAMPLED,
      labels: ['no-auto-merge'],
    });
    expect(t.gated()).toHaveLength(1);
    expect(t.gated()[0].msg.startsWith('t1-sampled')).toBe(true);
    expect(shipPhase.mock.calls[0][0].reviewRouting?.sample?.held).toBe(true);
  });

  it('lets an unsampled A-floor PR through with no label', async () => {
    const t = setup('docs/guide.md');
    await runIssue(request(UNSAMPLED, t1), policy, t.ports);
    expect(t.addLabels).not.toHaveBeenCalled();
    expect(t.gated()).toHaveLength(0);
    expect(shipPhase.mock.calls[0][0].reviewRouting).toMatchObject({ gated: false, sample: { held: false } });
  });

  it('holds a sensitive-path PR even when the sample would not', async () => {
    const t = setup('.github/workflows/ci.yml');
    await runIssue(request(UNSAMPLED, t1), policy, t.ports);
    expect(t.addLabels).toHaveBeenCalledTimes(1);
    expect(t.gated()[0].msg).toContain('classifier:floor:C:');
  });

  it('does not sample at T0, even at rate 1', async () => {
    const t = setup('docs/guide.md');
    await runIssue(request(SAMPLED, { ...classifier, t1SampleRate: 1 }), policy, t.ports);
    expect(t.addLabels).not.toHaveBeenCalled();
    expect(shipPhase.mock.calls[0][0].reviewRouting?.sample).toBeUndefined();
  });

  it('parks held and never ships when the label for a sampled PR cannot be applied', async () => {
    const t = setup('docs/guide.md', new Error('403'));
    const outcome = await runIssue(request(SAMPLED, t1), policy, t.ports);
    expect(outcome).toMatchObject({ state: 'parked', reason: 'held' });
    expect(shipPhase).not.toHaveBeenCalled();
  });
});
