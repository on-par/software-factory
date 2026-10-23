// packages/core/src/run/review-rework.test.ts — a queued review rework runs BUILD rework on the PR branch with only that review's comments, then CHECK (#3564)
import { join } from 'node:path';

import type { Octokit } from '@octokit/rest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { createTempDirs } from '../harness/temp-dir.js';
import type { BuildResult, buildPhase as realBuildPhase } from '../phases/build.js';
import type {
  CheckPhaseResult,
  checkPhase as realCheckPhase,
  reworkWorker as realReworkWorker,
} from '../phases/check.js';
import type { PlanResult, planPhase as realPlanPhase } from '../phases/plan.js';
import type { shipPhase as realShipPhase } from '../phases/ship.js';
import { ProviderBreaker } from '../router/breaker.js';
import { ModelRouter } from '../router/index.js';
import type { WorkRequest } from '../work/index.js';
import type { RunPolicy } from './policy.js';
import type { Workspace } from './ports.js';
import { renderReviewFeedback, ReviewReworkError, runReviewReworkBuild } from './review-rework.js';
import { runIssue, type RunPorts, type RunRequest } from './run-issue.js';

const planPhase = vi.fn<typeof realPlanPhase>();
const buildPhase = vi.fn<typeof realBuildPhase>();
const checkPhase = vi.fn<typeof realCheckPhase>();
const shipPhase = vi.fn<typeof realShipPhase>();
const reworkWorker = vi.fn<typeof realReworkWorker>();
const pullsCreate = vi.fn();

const PLAN_OK: PlanResult = { ok: true, route: 'codex', specPath: '/tmp/wt/spec.md', model: 'm', designArtifact: null };
const BUILD_OK: BuildResult = { ok: true, model: 'm', route: 'codex' };
const CHECK_OK: CheckPhaseResult = {
  passed: true,
  summary: { failures: 0, passes: 1, skips: 0, total: 1, results: [] },
  reworkRounds: 0,
};
const WORK: WorkRequest = {
  id: 'github-issue:o/r#42',
  kind: 'github-issue',
  title: 'Fix the thing',
  brief: 'do the thing',
  acceptanceCriteria: [],
};
const BRANCH = 'factory/42-x';

const request: RunRequest = {
  issue: 42,
  repo: 'o/r',
  branch: BRANCH,
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
const reviewRequest: RunRequest = { ...request, reviewRework: { prNumber: 7, reviewId: 200, reviewer: 'alice' } };

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

const tempDirs = createTempDirs();
const breakerDir = tempDirs.makeSync('review-rework-');
afterAll(() => tempDirs.cleanup());

const comment = (id: number, review: number, body: string, extra: Record<string, unknown> = {}) => ({
  id,
  pull_request_review_id: review,
  path: 'src/a.ts',
  line: 10,
  original_line: 9,
  body,
  user: { login: 'alice' },
  ...extra,
});

function fakeOctokit(pull: { state: string; head: { ref: string } } = { state: 'open', head: { ref: BRANCH } }) {
  const listReviewComments = vi.fn();
  const getReview = vi.fn(async () => ({
    data: { body: 'please rename', state: 'CHANGES_REQUESTED', user: { login: 'alice' } },
  }));
  const octokit = Object.assign({} as Octokit, {
    rest: { pulls: { get: vi.fn(async () => ({ data: pull })), getReview, listReviewComments, create: pullsCreate } },
    paginate: vi.fn(async () => [
      comment(1, 200, 'R-one'),
      comment(2, 100, 'OLD-only'),
      comment(3, 200, 'R-two', { line: null }),
    ]),
  });
  return { octokit, getReview };
}

const buildOpts = (octokit: Octokit) => ({
  target: { prNumber: 7, reviewId: 200, reviewer: 'alice' },
  repo: 'o/r',
  branch: BRANCH,
  octokit,
  checkOpts: { log: vi.fn(), issue: 42, worktree: '/tmp/wt' } as never,
  rework: reworkWorker,
});

function ports(octokit: Octokit): RunPorts {
  return {
    router: new ModelRouter(MODELS, ROUTES),
    octokit,
    workspace: { path: '/tmp/wt', dispose: async () => {} } as Workspace,
    events: () => vi.fn(),
    breaker: new ProviderBreaker(join(breakerDir, 'breaker.json')),
    resolveConstitution: () => null,
    planPhase,
    buildPhase,
    checkPhase,
    shipPhase,
    reworkWorker,
  };
}

beforeEach(() => {
  planPhase.mockReset().mockResolvedValue(PLAN_OK);
  buildPhase.mockReset().mockResolvedValue(BUILD_OK);
  checkPhase.mockReset().mockResolvedValue(CHECK_OK);
  shipPhase.mockReset().mockResolvedValue({ ok: true, prNumber: 7 });
  reworkWorker.mockReset().mockResolvedValue({ failovers: [], modelCompleted: true });
  pullsCreate.mockReset();
});

describe('review rework (#3564)', () => {
  it('review rework builds on the PR branch with only the triggering review', async () => {
    const { octokit } = fakeOctokit();
    const outcome = await runIssue(reviewRequest, policy, ports(octokit));
    expect(outcome).toMatchObject({ state: 'ready' });
    expect(planPhase).not.toHaveBeenCalled();
    expect(buildPhase).not.toHaveBeenCalled();
    expect(reworkWorker).toHaveBeenCalledTimes(1);
    const opts = reworkWorker.mock.calls[0][0];
    expect(opts.worktree).toBe('/tmp/wt');
    const details = opts.summary.results[0].details ?? '';
    const block = /\n<untrusted-review-feedback>\n([\s\S]*)\n<\/untrusted-review-feedback>$/.exec(details)?.[1] ?? '';
    expect(block).toContain('please rename');
    expect(block).toContain('R-one');
    expect(block).toContain('R-two');
    expect(details).not.toContain('OLD-only');
    expect(reworkWorker.mock.invocationCallOrder[0]).toBeLessThan(checkPhase.mock.invocationCallOrder[0]);
    expect(shipPhase.mock.calls[0][0].branch).toBe(BRANCH);
    expect(pullsCreate).not.toHaveBeenCalled();
  });

  it('throws ReviewReworkError when the PR head ref is not the run branch', async () => {
    const { octokit } = fakeOctokit({ state: 'open', head: { ref: 'other' } });
    await expect(runReviewReworkBuild(buildOpts(octokit))).rejects.toThrow(ReviewReworkError);
    expect(await runIssue(reviewRequest, policy, ports(octokit))).toMatchObject({ state: 'parked' });
    expect(reworkWorker).not.toHaveBeenCalled();
    expect(checkPhase).not.toHaveBeenCalled();
  });

  it('throws when the PR is closed', async () => {
    const { octokit } = fakeOctokit({ state: 'closed', head: { ref: BRANCH } });
    await expect(runReviewReworkBuild(buildOpts(octokit))).rejects.toThrow(/closed/);
    expect(await runIssue(reviewRequest, policy, ports(octokit))).toMatchObject({ state: 'parked' });
    expect(reworkWorker).not.toHaveBeenCalled();
  });

  it('throws when review R cannot be read', async () => {
    const { octokit, getReview } = fakeOctokit();
    getReview.mockRejectedValueOnce(new Error('Not Found'));
    await expect(runReviewReworkBuild(buildOpts(octokit))).rejects.toThrow(
      /could not read PR #7 \/ review 200: Not Found/,
    );
    expect(reworkWorker).not.toHaveBeenCalled();
  });

  it('throws when the rework worker never ran', async () => {
    reworkWorker.mockResolvedValueOnce({ failovers: [], modelCompleted: false, failureReason: 'boom' } as never);
    const { octokit } = fakeOctokit();
    expect(await runIssue(reviewRequest, policy, ports(octokit))).toMatchObject({ state: 'parked' });
    expect(checkPhase).not.toHaveBeenCalled();
    expect(shipPhase).not.toHaveBeenCalled();
  });

  it('resumeFrom wins over reviewRework and makes no review rework call', async () => {
    const { octokit } = fakeOctokit();
    const resumeFrom = { phase: 'check' as const, route: 'claude' as const, model: 'm', buildMinutes: 1 };
    await runIssue({ ...reviewRequest, resumeFrom }, policy, ports(octokit));
    expect(reworkWorker).not.toHaveBeenCalled();
    expect(planPhase).not.toHaveBeenCalled();
  });

  it('renderReviewFeedback renders an empty review and outdated comments', () => {
    const base = { prNumber: 7, reviewId: 200, reviewer: 'alice', state: 'CHANGES_REQUESTED', body: '' };
    const empty = renderReviewFeedback({ ...base, comments: [] });
    expect(empty).toContain('(no review body)');
    expect(empty).toContain('(no inline comments)');
    const outdated = renderReviewFeedback({
      ...base,
      comments: [{ path: 'a.ts', body: 'x', author: 'bob' }],
    });
    expect(outdated).toContain('- a.ts (@bob):\n  x');
    const huge = renderReviewFeedback({ ...base, body: 'z'.repeat(30_000), comments: [] });
    expect(huge).toContain('… (review truncated)\n</untrusted-review-feedback>');
  });

  it('uses original_line for an outdated comment and keeps GitHub order', async () => {
    const { octokit } = fakeOctokit();
    const rework = vi.fn<typeof realReworkWorker>().mockResolvedValue({ failovers: [], modelCompleted: true });
    const checkOpts = { log: vi.fn(), issue: 42, worktree: '/tmp/wt' } as never;
    const { feedback } = await runReviewReworkBuild({
      target: { prNumber: 7, reviewId: 200, reviewer: 'alice' },
      repo: 'o/r',
      branch: BRANCH,
      octokit,
      checkOpts,
      rework,
    });
    expect(feedback.comments.map((c) => [c.body, c.line])).toEqual([
      ['R-one', 10],
      ['R-two', 9],
    ]);
  });

  it('a request without reviewRework still plans and builds', async () => {
    const { octokit } = fakeOctokit();
    await runIssue(request, policy, ports(octokit));
    expect(planPhase).toHaveBeenCalled();
    expect(buildPhase).toHaveBeenCalled();
    expect(reworkWorker).not.toHaveBeenCalled();
  });
});
