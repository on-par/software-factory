import { join } from 'node:path';

import { createTempDirs } from '@on-par/factory-core/testing';
import type { Octokit } from '@octokit/rest';
import { afterAll, describe, expect, it, vi } from 'vitest';

import type { buildPhase as realBuildPhase } from '../phases/build.js';
import type { checkPhase as realCheckPhase } from '../phases/check.js';
import type { planPhase as realPlanPhase } from '../phases/plan.js';
import type { shipPhase as realShipPhase } from '../phases/ship.js';
import { ProviderBreaker } from '../router/breaker.js';
import { ModelRouter } from '../router/index.js';
import type { DesignArtifact } from '../types/index.js';
import type { WorkRequest } from '../work/index.js';
import type { Workspace } from './ports.js';
import { WORKER_MODELS, WORKER_ROUTES, workerPolicy as policy } from '../test-support/worker-policy.js';
import { runIssue, type RunPorts, type RunRequest } from './run-issue.js';

const WORK: WorkRequest = {
  id: 'github-issue:o/r#1',
  kind: 'github-issue',
  title: 'Fix the thing',
  brief: 'do the thing',
  acceptanceCriteria: [],
};

const dirs = createTempDirs();
const breakerDir = dirs.makeSync('run-issue-no-diff-');
afterAll(() => dirs.cleanup());

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

const buildOpts: Parameters<typeof realBuildPhase>[0][] = [];

function portsWith(
  planPhase: typeof realPlanPhase,
  buildPhase: typeof realBuildPhase,
  events: (type: string, msg: string) => void,
): RunPorts {
  return {
    router: new ModelRouter(WORKER_MODELS, WORKER_ROUTES),
    octokit: {} as Octokit,
    workspace: { path: '/tmp/wt', dispose: async () => {} } as Workspace,
    events: () => events,
    breaker: new ProviderBreaker(join(breakerDir, 'breaker.json')),
    resolveConstitution: () => null,
    planPhase,
    buildPhase: async (o) => (buildOpts.push(o), buildPhase(o)),
    checkPhase: vi.fn<typeof realCheckPhase>(),
    shipPhase: vi.fn<typeof realShipPhase>(),
  };
}

const OPEN_QUESTION = 'Where do test commands come from?';
const DESIGN: DesignArtifact = {
  restatedProblem: 'problem',
  approach: { chosen: 'chosen', rejected: [] },
  interfacesTouched: [],
  targetTypes: [],
  signatures: [],
  callGraph: [],
  behaviorContract: [],
  verificationPlan: [],
  riskBlastRadius: 'low',
  openQuestions: [OPEN_QUESTION],
};

describe('runIssue — no-diff park message (#3273)', () => {
  it.each([
    ['no_diff', 'build produced no diff against the base ref'],
    ['junk_only_diff', 'build changed only generated/cache files'],
  ] as const)('appends the %s detail to the park message and passes the plan open questions', async (reason, text) => {
    const planPhase = vi.fn<typeof realPlanPhase>().mockResolvedValue({
      ok: true,
      route: 'claude',
      specPath: '/tmp/wt/spec.md',
      model: 'm',
      designArtifact: DESIGN,
    });
    const buildPhase = vi.fn<typeof realBuildPhase>().mockResolvedValue({
      ok: false,
      model: 'm',
      route: 'claude',
      reason,
      noDiffCause: 'sandbox',
      noDiffDetail: 'cause: sandbox\nsandbox_apply: Operation not permitted',
    });
    const events: Array<[string, string]> = [];
    buildOpts.length = 0;
    const outcome = await runIssue(
      request,
      policy,
      portsWith(planPhase, buildPhase, (t, m) => events.push([t, m])),
    );
    expect(outcome).toMatchObject({ state: 'parked', reason: 'fail' });
    const parked = events.find(([type]) => type === 'fail')?.[1] ?? '';
    expect(parked).toContain(text);
    expect(parked).toContain('cause: sandbox');
    expect(parked).toContain('sandbox_apply');
    expect(buildOpts[0]?.openQuestions).toEqual([OPEN_QUESTION]);
  });

  it('leaves the park message unchanged when the build carries no detail', async () => {
    const planPhase = vi
      .fn<typeof realPlanPhase>()
      .mockResolvedValue({ ok: true, route: 'claude', specPath: '/tmp/wt/spec.md', model: 'm', designArtifact: null });
    const buildPhase = vi
      .fn<typeof realBuildPhase>()
      .mockResolvedValue({ ok: false, model: 'm', route: 'claude', reason: 'no_diff' });
    const events: Array<[string, string]> = [];
    buildOpts.length = 0;
    await runIssue(
      request,
      policy,
      portsWith(planPhase, buildPhase, (t, m) => events.push([t, m])),
    );
    expect(events.find(([type]) => type === 'fail')?.[1]).toBe(
      'build produced no diff against the base ref — no implementation was produced',
    );
    expect(buildOpts[0]?.openQuestions).toBeUndefined();
  });
});
