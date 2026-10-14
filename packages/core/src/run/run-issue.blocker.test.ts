import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Octokit } from '@octokit/rest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import type { BuildResult, buildPhase as realBuildPhase } from '../phases/build.js';
import type { CheckPhaseResult, checkPhase as realCheckPhase } from '../phases/check.js';
import type { PlanResult, planPhase as realPlanPhase } from '../phases/plan.js';
import type { ShipResult, shipPhase as realShipPhase } from '../phases/ship.js';
import { ProviderBreaker } from '../router/breaker.js';
import { ModelRouter } from '../router/index.js';
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

const WORK: WorkRequest = {
  id: 'github-issue:o/r#1',
  kind: 'github-issue',
  title: 'Fix the thing',
  brief: 'do the thing',
  acceptanceCriteria: [],
};

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

const ROUTES: RoutesConfig = { version: 1, routes: {} };
const MODELS: ModelsConfig = {
  version: 1,
  models: {},
  tiers: {},
  failover: { triggers: [], maxRetries: 0, cooldownMs: 0, escalateAfterTierExhausted: false },
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

const breakerDir = mkdtempSync(join(tmpdir(), 'run-issue-blocker-'));
afterAll(() => rmSync(breakerDir, { recursive: true, force: true }));

type Log = ReturnType<RunPorts['events']>;

/** Fake octokit covering both the blocker filer (#2316) and the park comment (#2314). */
function fakeOctokit(opts: { createThrows?: boolean } = {}) {
  const create = vi.fn(async (params: { body: string }) => {
    if (opts.createThrows) throw new Error('create boom');
    return { data: { number: 77, id: 9077, body: params.body } };
  });
  const createComment = vi.fn(async (_args: { body: string }) => ({ data: { id: 1 } }));
  const octokit = Object.assign({} as Octokit, {
    request: vi.fn(async (route: string) => ({ data: route.startsWith('GET') ? [] : {} })),
    paginate: vi.fn(async () => []),
    rest: {
      users: { getAuthenticated: vi.fn(async () => ({ data: { id: 9 } })) },
      issues: {
        get: vi.fn(async () => ({ data: { body: 'parent body' } })),
        create,
        listComments: vi.fn(async () => ({ data: [] })),
        createComment,
        updateComment: vi.fn(),
      },
    },
  });
  return { octokit, create, createComment };
}

function ports(log: Log, octokit: Octokit = {} as Octokit): RunPorts {
  return {
    router: new ModelRouter(MODELS, ROUTES),
    octokit,
    workspace: { path: '/tmp/wt', dispose: async () => {} } as Workspace,
    events: () => log,
    breaker: new ProviderBreaker(join(breakerDir, 'breaker.json')),
    resolveConstitution: () => null,
    planPhase,
    buildPhase,
    checkPhase,
    shipPhase,
  };
}

beforeEach(() => {
  vi.mocked(shipPhase)
    .mockReset()
    .mockResolvedValue({ ok: true, prNumber: 42 } satisfies ShipResult);
  vi.mocked(planPhase).mockReset().mockResolvedValue(PLAN_OK);
  vi.mocked(buildPhase).mockReset().mockResolvedValue(BUILD_OK);
  vi.mocked(checkPhase).mockReset().mockResolvedValue(CHECK_OK);
});

describe('runIssue — BLOCKED_BY claims (#2317)', () => {
  const claim = { title: 'Add storage layer', problem: 'Storage is missing', inScope: ['a'], acceptance: ['b'] };
  const line = 'BLOCKED_BY: Add storage layer | Storage is missing';

  it('a valid PLAN BLOCKED_BY claim files one blocker and parks blocked naming the child', async () => {
    vi.mocked(planPhase).mockResolvedValue({ ...PLAN_OK, ok: false, escalate: line, blocker: claim });
    const { octokit, create, createComment } = fakeOctokit();
    const outcome = await runIssue(request, policy, ports(vi.fn<Log>(), octokit));
    expect(outcome).toMatchObject({ state: 'parked', reason: 'blocked' });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0]).toMatchObject({ title: 'Add storage layer' });
    const { body } = createComment.mock.calls[0][0];
    expect(body).toContain('reason: blocked');
    expect(body).toContain('blockers: #77');
    expect(body).toContain('blocked by #77');
  });

  it('a valid BUILD BLOCKED_BY claim parks blocked with branch and park SHA in the comment', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'run-issue-blocked-repo-'));
    try {
      const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
      git('init', '-q');
      git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-q', '-m', 'wip');
      const head = git('rev-parse', 'HEAD');
      vi.mocked(buildPhase).mockResolvedValue({
        ok: false,
        model: 'm',
        route: 'codex',
        escalate: line,
        blocker: claim,
      });
      const { octokit, createComment } = fakeOctokit();
      const base = ports(vi.fn<Log>(), octokit);
      const outcome = await runIssue(request, policy, {
        ...base,
        workspace: { path: repo, dispose: async () => {} } as Workspace,
      });
      expect(outcome).toMatchObject({ state: 'parked', reason: 'blocked' });
      const { body } = createComment.mock.calls[0][0];
      expect(body).toContain('reason: blocked');
      expect(body).toContain('blockers: #77');
      expect(body).toContain('branch: issue-1-fix-the-thing');
      expect(body).toContain(`park-sha: ${head}`);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('a claim restating the parent escalates without filing', async () => {
    vi.mocked(planPhase).mockResolvedValue({
      ...PLAN_OK,
      ok: false,
      escalate: line,
      blocker: { ...claim, title: 'Fix the thing' },
    });
    const { octokit, create, createComment } = fakeOctokit();
    const outcome = await runIssue(request, policy, ports(vi.fn<Log>(), octokit));
    expect(outcome).toMatchObject({ state: 'escalated' });
    expect(create).not.toHaveBeenCalled();
    expect(createComment).not.toHaveBeenCalled();
  });

  it('a filer refusal parks held with the refusal reason', async () => {
    vi.mocked(planPhase).mockResolvedValue({ ...PLAN_OK, ok: false, escalate: line, blocker: claim });
    const { octokit, createComment } = fakeOctokit({ createThrows: true });
    const outcome = await runIssue(request, policy, ports(vi.fn<Log>(), octokit));
    expect(outcome).toMatchObject({ state: 'parked', reason: 'held' });
    const { body } = createComment.mock.calls[0][0];
    expect(body).toContain('reason: held');
    expect(body).toContain('blocker filing refused (create-failed)');
  });

  it('localOnly escalates with the claim line and files nothing', async () => {
    vi.mocked(planPhase).mockResolvedValue({ ...PLAN_OK, ok: false, escalate: line, blocker: claim });
    const { octokit, create } = fakeOctokit();
    const outcome = await runIssue({ ...request, localOnly: true }, policy, ports(vi.fn<Log>(), octokit));
    expect(outcome).toMatchObject({ state: 'escalated', reason: `plan escalated: ${line}` });
    expect(create).not.toHaveBeenCalled();
  });

  it('a localOnly claim without an escalate line reports unknown', async () => {
    vi.mocked(buildPhase).mockResolvedValue({ ok: false, model: 'm', route: 'codex', blocker: claim });
    const outcome = await runIssue({ ...request, localOnly: true }, policy, ports(vi.fn<Log>()));
    expect(outcome).toMatchObject({ state: 'escalated', reason: 'build escalated: unknown' });
  });
});
