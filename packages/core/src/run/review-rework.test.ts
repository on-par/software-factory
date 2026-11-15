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
import { fakeOctokit } from '../test-support/index.js';
import type { WorkRequest } from '../work/index.js';
import type { RunPolicy } from './policy.js';
import type { Workspace } from './ports.js';
import {
  fetchCommentFeedback,
  renderReviewFeedback,
  ReviewReworkError,
  reviewReworkResume,
  runRequestedReviewRework,
  runReviewReworkBuild,
} from './review-rework.js';
import { runIssue, type RunPorts, type RunRequest } from './run-issue.js';

const planPhase = vi.fn<typeof realPlanPhase>();
const buildPhase = vi.fn<typeof realBuildPhase>();
const checkPhase = vi.fn<typeof realCheckPhase>();
const shipPhase = vi.fn<typeof realShipPhase>();
const reworkWorker = vi.fn<typeof realReworkWorker>();
const pullsCreate = vi.fn(() => order.push('pulls.create'));
const order: string[] = [];
const reworkCalls: Parameters<typeof realReworkWorker>[0][] = [];
const checkCalls: Parameters<typeof realCheckPhase>[0][] = [];
const shipCalls: Parameters<typeof realShipPhase>[0][] = [];
const apiCalls: string[] = [];

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
const SHIP_OK = { ok: true, prNumber: 7 } as const;
const DONE = { failovers: [], modelCompleted: true };
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

function reworkOctokit(pull: { state: string; head: { ref: string } } = { state: 'open', head: { ref: BRANCH } }) {
  const listReviewComments = vi.fn();
  const review = { data: { body: 'please rename', state: 'CHANGES_REQUESTED', user: { login: 'alice' } } };
  const getReview = vi.fn(async () => (apiCalls.push('getReview'), review));
  const getPull = vi.fn(async () => (apiCalls.push('pulls.get'), { data: pull }));
  const { octokit } = fakeOctokit({
    'pulls.get': getPull,
    'pulls.getReview': getReview,
    'pulls.listReviewComments': listReviewComments,
    'pulls.create': pullsCreate,
    paginate: vi.fn(async () => [
      comment(1, 200, 'R-one'),
      comment(2, 100, 'OLD-only'),
      comment(3, 200, 'R-two', { line: null }),
    ]),
  });
  octokit.rest.pulls.get = vi.fn(octokit.rest.pulls.get);
  return { octokit: octokit as Octokit, getReview };
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
  for (const recorded of [order, reworkCalls, checkCalls, shipCalls, apiCalls]) recorded.length = 0;
  planPhase.mockReset().mockImplementation(async () => (order.push('plan'), PLAN_OK));
  buildPhase.mockReset().mockImplementation(async () => (order.push('build'), BUILD_OK));
  checkPhase.mockReset().mockImplementation(async (opts) => (order.push('check'), checkCalls.push(opts), CHECK_OK));
  shipPhase.mockReset().mockImplementation(async (opts) => (order.push('ship'), shipCalls.push(opts), SHIP_OK));
  reworkWorker.mockReset().mockImplementation(async (o) => (order.push('rework'), reworkCalls.push(o), DONE));
});

describe('comment rework (#3882)', () => {
  const commentRequest: RunRequest = {
    ...request,
    reviewRework: { prNumber: 7, reviewId: 300, reviewer: 'alice', source: 'comment' },
  };
  const withComment = (body: string | null, pull?: { state: string; head: { ref: string } }) => {
    const { octokit, getReview } = reworkOctokit(pull);
    const getComment = async () => (apiCalls.push('getComment'), { data: { body, user: { login: 'alice' } } });
    Object.assign((octokit as any).rest, { issues: { getComment } });
    return { octokit, getReview };
  };

  it("a comment rework builds on the PR branch from that comment's feedback only", async () => {
    const { octokit } = withComment('/factory rework rename foo to bar\nand tidy up');
    expect(await runIssue(commentRequest, policy, ports(octokit))).toMatchObject({ state: 'ready' });
    expect(order).toEqual(['rework', 'check', 'ship']);
    const details = reworkCalls[0].summary.results[0].details ?? '';
    expect(details).toContain('Comment 300 by @alice on PR #7');
    expect(details).toContain('rename foo to bar\nand tidy up');
    expect(details).not.toContain('/factory rework');
    expect(details).not.toContain('Inline comments:');
    expect(apiCalls).not.toContain('getReview');
  });

  it('a comment rework fails closed when the PR is not open on the run branch', async () => {
    const { octokit } = withComment('/factory rework x', { state: 'open', head: { ref: 'other' } });
    expect(await runIssue(commentRequest, policy, ports(octokit))).toMatchObject({ state: 'parked' });
    expect([apiCalls, order]).toEqual([['pulls.get'], []]);
  });

  it('throws ReviewReworkError when the comment is no longer a rework command', async () => {
    for (const body of ['edited away', '/factory rework', null]) {
      const { octokit } = withComment(body);
      await expect(
        fetchCommentFeedback(octokit, { owner: 'o', repo: 'r', prNumber: 7, commentId: 300 }),
      ).rejects.toThrow(ReviewReworkError);
    }
  });
});

describe('review rework (#3564)', () => {
  it('review rework builds on the PR branch with only the triggering review', async () => {
    const { octokit } = reworkOctokit();
    const outcome = await runIssue(reviewRequest, policy, ports(octokit));
    expect(outcome).toMatchObject({ state: 'ready' });
    expect(order).toEqual(['rework', 'check', 'ship']);
    const opts = reworkCalls[0];
    expect(opts.worktree).toBe('/tmp/wt');
    const details = opts.summary.results[0].details ?? '';
    const block = /\n<untrusted-review-feedback>\n([\s\S]*)\n<\/untrusted-review-feedback>$/.exec(details)?.[1] ?? '';
    expect(block).toContain('please rename');
    expect(block).toContain('R-one');
    expect(block).toContain('R-two');
    expect(details).not.toContain('OLD-only');
    expect(shipCalls[0].branch).toBe(BRANCH);
  });

  it('throws ReviewReworkError when the PR head ref is not the run branch', async () => {
    const { octokit } = reworkOctokit({ state: 'open', head: { ref: 'other' } });
    await expect(runReviewReworkBuild(buildOpts(octokit))).rejects.toThrow(ReviewReworkError);
    expect(await runIssue(reviewRequest, policy, ports(octokit))).toMatchObject({ state: 'parked' });
    expect(order).toEqual([]);
  });

  it('throws when the PR is closed', async () => {
    const { octokit } = reworkOctokit({ state: 'closed', head: { ref: BRANCH } });
    await expect(runReviewReworkBuild(buildOpts(octokit))).rejects.toThrow(/closed/);
    expect(await runIssue(reviewRequest, policy, ports(octokit))).toMatchObject({ state: 'parked' });
    expect(order).not.toContain('rework');
  });

  it('throws when review R cannot be read', async () => {
    const { octokit, getReview } = reworkOctokit();
    getReview.mockRejectedValueOnce(new Error('Not Found'));
    await expect(runReviewReworkBuild(buildOpts(octokit))).rejects.toThrow(
      /could not read PR #7 \/ review 200: Not Found/,
    );
    expect(order).not.toContain('rework');
  });

  it('throws when the rework worker never ran', async () => {
    reworkWorker.mockResolvedValueOnce({ failovers: [], modelCompleted: false, failureReason: 'boom' } as never);
    const { octokit } = reworkOctokit();
    expect(await runIssue(reviewRequest, policy, ports(octokit))).toMatchObject({ state: 'parked' });
    expect(order).toEqual([]);
  });

  it('resumeFrom wins over reviewRework and makes no review rework call', async () => {
    const { octokit } = reworkOctokit();
    const resumeFrom = { phase: 'check' as const, route: 'claude' as const, model: 'm', buildMinutes: 1 };
    await runIssue({ ...reviewRequest, resumeFrom }, policy, ports(octokit));
    expect(order).toEqual(['check', 'ship']);
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
    const { octokit } = reworkOctokit();
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
    const { octokit } = reworkOctokit();
    await runIssue(request, policy, ports(octokit));
    expect(order).toEqual(['plan', 'build', 'check', 'ship']);
  });
});

describe('iterate (#3625)', () => {
  const iterateRequest: RunRequest = { ...request, iterate: { prNumber: 7, commentId: 300, actor: 'alice' } };

  it('an iterate request skips PLAN and BUILD and runs CHECK on the PR branch', async () => {
    const { octokit } = reworkOctokit();
    const outcome = await runIssue(iterateRequest, policy, ports(octokit));
    expect(outcome).toMatchObject({ state: 'ready' });
    expect(order).toEqual(['check', 'ship']);
    expect(checkCalls[0].worktree).toBe('/tmp/wt');
    expect(shipCalls[0].branch).toBe(BRANCH);
  });

  it.each([
    ['closed', { state: 'closed', head: { ref: BRANCH } }],
    ['retargeted', { state: 'open', head: { ref: 'other' } }],
  ])('throws ReviewReworkError and never ships when the PR is %s', async (_name, pull) => {
    const { octokit } = reworkOctokit(pull);
    expect(await runIssue(iterateRequest, policy, ports(octokit))).toMatchObject({ state: 'parked' });
    expect(order).toEqual([]);
  });

  it('wraps a PR read error as ReviewReworkError', async () => {
    const { octokit } = reworkOctokit();
    vi.mocked(octokit.rest.pulls.get).mockRejectedValueOnce(new Error('Not Found'));
    expect(await runIssue(iterateRequest, policy, ports(octokit))).toMatchObject({ state: 'parked' });
    expect(order).not.toContain('ship');
  });

  it('runRequestedReviewRework rejects with ReviewReworkError directly', async () => {
    const { octokit } = reworkOctokit({ state: 'closed', head: { ref: BRANCH } });
    await expect(
      runRequestedReviewRework(iterateRequest, { octokit, reworkWorker }, { log: vi.fn() } as never),
    ).rejects.toThrow(ReviewReworkError);
  });

  it('resumeFrom wins over iterate', async () => {
    const { octokit } = reworkOctokit({ state: 'closed', head: { ref: BRANCH } });
    const resumeFrom = { phase: 'check' as const, route: 'claude' as const, model: 'm', buildMinutes: 1 };
    await runIssue({ ...iterateRequest, resumeFrom }, policy, ports(octokit));
    expect([apiCalls, order]).toEqual([[], ['check', 'ship']]);
  });
});

describe('feedback round rework (#3910)', () => {
  const feedbackRequest: RunRequest = { ...request, feedbackRound: { prNumber: 7 } };
  const summary = {
    failures: 1,
    passes: 0,
    skips: 0,
    total: 1,
    results: [{ checker: 'review_feedback', result: 'FAIL' as const, details: 'rename it' }],
  };

  it('resumes at CHECK unless the plan re-plans', () => {
    expect(reviewReworkResume(feedbackRequest)).toMatchObject({ phase: 'check' });
    expect(reviewReworkResume(feedbackRequest, { replan: false })).toMatchObject({ phase: 'check' });
    expect(reviewReworkResume(feedbackRequest, { replan: true })).toBeUndefined();
    expect(reviewReworkResume(request, { replan: false })).toBeUndefined();
  });

  it('reworks with the plan summary after the open-PR guard', async () => {
    const { octokit } = reworkOctokit();
    const log = vi.fn();
    await runRequestedReviewRework(feedbackRequest, { octokit, reworkWorker }, { log } as never, {
      prNumber: 7,
      summary,
    });
    expect(reworkCalls).toHaveLength(1);
    expect(reworkCalls[0]).toMatchObject({
      summary,
      extraInstructions: expect.stringContaining('reviewer'),
    });
  });

  it('does nothing when no item is actionable', async () => {
    const { octokit } = reworkOctokit();
    await runRequestedReviewRework(feedbackRequest, { octokit, reworkWorker }, { log: vi.fn() } as never, {
      prNumber: 7,
      summary: undefined,
    });
    expect(order).not.toContain('rework');
  });

  it('fails closed when the PR is closed, and wraps a read error', async () => {
    const closed = reworkOctokit({ state: 'closed', head: { ref: BRANCH } });
    const plan = { prNumber: 7, summary };
    await expect(
      runRequestedReviewRework(
        feedbackRequest,
        { octokit: closed.octokit, reworkWorker },
        { log: vi.fn() } as never,
        plan,
      ),
    ).rejects.toThrow(ReviewReworkError);
    const broken = reworkOctokit();
    vi.mocked(broken.octokit.rest.pulls.get).mockRejectedValueOnce(new Error('Not Found'));
    await expect(
      runRequestedReviewRework(
        feedbackRequest,
        { octokit: broken.octokit, reworkWorker },
        { log: vi.fn() } as never,
        plan,
      ),
    ).rejects.toThrow('could not read');
    expect(order).not.toContain('rework');
  });

  it('runIssue triages, reworks the actionable feedback at CHECK, ships and answers the comment', async () => {
    const { octokit } = reworkOctokit();
    const posted: string[] = [];
    const listComments = vi.fn();
    Object.assign(octokit.rest, {
      issues: {
        listComments,
        createComment: vi.fn(async (a: { body: string }) => {
          posted.push(a.body);
          return { data: {} };
        }),
      },
      users: { getAuthenticated: vi.fn(async () => ({ data: { login: 'factory-bot' } })) },
      repos: { getCollaboratorPermissionLevel: vi.fn(async () => ({ data: { permission: 'admin' } })) },
    });
    Object.assign(octokit.rest.pulls, { listReviews: vi.fn(), update: vi.fn(), requestReviewers: vi.fn() });
    Object.assign(octokit, {
      graphql: vi.fn(async () => ({ repository: { pullRequest: { reviewThreads: { nodes: [] } } } })),
      paginate: vi.fn(async (route: unknown) =>
        route === listComments ? [{ id: 5, user: { login: 'maint' }, body: 'please rename foo', html_url: 'u' }] : [],
      ),
    });
    shipPhase.mockImplementation(async (opts) => (shipCalls.push(opts), { ...SHIP_OK, headSha: 'abcdef1234567' }));
    const outcome = await runIssue({ ...feedbackRequest, trustedApprovers: ['maint'] }, policy, ports(octokit));
    expect(outcome).toMatchObject({ state: 'ready' });
    expect(order).not.toContain('plan');
    expect(reworkCalls[0].summary.results[0].details).toContain('please rename foo');
    expect(shipCalls).toHaveLength(1);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain('Fixed in [`abcdef1`]');
  });
});
