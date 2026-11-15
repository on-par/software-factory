import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
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
import { parkUnblockHint } from './park-comment.js';
import type { Workspace } from './ports.js';
import { workKeyFromIssue } from '../work/work-key.js';
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

const breakerDir = mkdtempSync(join(tmpdir(), 'run-issue-park-comment-'));
afterAll(() => rmSync(breakerDir, { recursive: true, force: true }));

type Log = ReturnType<RunPorts['events']>;

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

const overBudget: RunPolicy = { ...policy, budget: { perIssueCapUsd: 1 } };

function commentOctokit(createComment = vi.fn(async (_args: { body: string }) => ({ data: { id: 1 } }))) {
  const getAuthenticated = vi.fn(async () => ({ data: { id: 9 } }));
  const octokit = Object.assign({} as Octokit, {
    rest: {
      users: { getAuthenticated },
      issues: { listComments: vi.fn(async () => ({ data: [] })), createComment, updateComment: vi.fn() },
    },
  });
  return { octokit, createComment, getAuthenticated };
}

function parkingPorts(log: Log, octokit?: Octokit): RunPorts {
  return { ...ports(log, octokit), getIssueSpend: () => 2 };
}

describe('runIssue — issue park comment (#2314)', () => {
  it('posts one marked comment on a park', async () => {
    const { octokit, createComment } = commentOctokit();
    const outcome = await runIssue(request, overBudget, parkingPorts(vi.fn<Log>(), octokit));
    expect(outcome).toMatchObject({ state: 'parked', reason: 'fail' });
    expect(createComment).toHaveBeenCalledTimes(1);
    const { body } = createComment.mock.calls[0][0];
    expect(body).toContain('issue:1 -->');
    expect(body).toContain('reason: fail');
    expect(body).not.toContain('Run logs:');
  });

  it('includes a run log location in the comment only after a worker result was written', async () => {
    const logsDir = join(breakerDir, 'run-logs');
    vi.mocked(planPhase).mockImplementation(async (opts) => {
      await opts.onWorkerResult?.({ model: 'plan-model', output: 'plan output', exitCode: 0, attempts: [] });
      return PLAN_OK;
    });
    const { octokit, createComment } = commentOctokit();
    await runIssue({ ...request, logsDir }, overBudget, parkingPorts(vi.fn<Log>(), octokit));
    expect(createComment.mock.calls[0][0].body).toContain(`Run logs: ${logsDir}/issue-1/run-`);
  });

  it('keeps the parked outcome and omits the location when worker log writing fails', async () => {
    const logsPath = join(breakerDir, 'logs-file');
    writeFileSync(logsPath, 'not a directory');
    const planResult = { model: 'plan-model', output: 'plan output', exitCode: 0, attempts: [] };
    vi.mocked(planPhase).mockImplementation(async (opts) => {
      await opts.onWorkerResult?.(planResult);
      return PLAN_OK;
    });
    const baseline = await runIssue(request, overBudget, parkingPorts(vi.fn<Log>()));
    const log = vi.fn<Log>();
    const outcome = await runIssue({ ...request, logsDir: logsPath }, overBudget, parkingPorts(log));
    expect(outcome).toEqual(baseline);
    expect(log.mock.calls.some(([type, message]) => type === 'warn' && message.includes('write failed'))).toBe(true);
    expect(log.mock.calls.some(([, message]) => message.includes('Run logs:'))).toBe(false);
  });

  it('runIssue writes plan and build worker logs for a parked run', async () => {
    const logsDir = join(breakerDir, 'parked-run-logs');
    vi.mocked(planPhase).mockImplementation(async (opts) => {
      await opts.onWorkerResult?.({ model: 'plan-model', output: 'valid plan output', exitCode: 0, attempts: [] });
      return PLAN_OK;
    });
    vi.mocked(buildPhase).mockImplementation(async (opts) => {
      await opts.onWorkerResult?.({
        model: 'build-model',
        output: 'distinctive build final line',
        exitCode: 0,
        attempts: [],
      });
      return BUILD_OK;
    });
    vi.mocked(checkPhase).mockRejectedValueOnce(new Error('park after build'));
    const log = vi.fn<Log>();
    const outcome = await runIssue({ ...request, logsDir, localOnly: true }, policy, ports(log));
    expect(outcome.state).toBe('parked');
    const terminal = log.mock.calls.find(([type, message]) => type === 'fail' && message.includes('Run logs:'))?.[1];
    if (!terminal) throw new Error('expected the terminal event to include the written log path');
    const directory = /Run logs: (.+)$/.exec(terminal)?.[1];
    if (!directory) throw new Error('expected a run log directory');
    const planLog = await readFile(join(directory, 'plan.log'), 'utf8');
    const buildLog = await readFile(join(directory, 'build.log'), 'utf8');
    expect(planLog).toContain('plan-model');
    expect(planLog).toContain('valid plan output');
    expect(buildLog).toContain('build-model');
    expect(buildLog).toContain('distinctive build final line');
  });

  it('a failing comment create leaves the parked outcome unchanged and logs environment_warning', async () => {
    const baseline = await runIssue(request, overBudget, parkingPorts(vi.fn<Log>()));
    const log = vi.fn<Log>();
    const { octokit } = commentOctokit(vi.fn().mockRejectedValue(new Error('403')));
    const outcome = await runIssue(request, overBudget, parkingPorts(log, octokit));
    expect(outcome).toEqual(baseline);
    const warnings = log.mock.calls.filter(
      ([type, message]) => type === 'environment_warning' && message.includes('park comment'),
    );
    expect(warnings).toHaveLength(1);
  });

  it('localOnly makes no octokit call', async () => {
    const { octokit, createComment, getAuthenticated } = commentOctokit();
    await runIssue({ ...request, localOnly: true }, overBudget, parkingPorts(vi.fn<Log>(), octokit));
    expect(createComment).not.toHaveBeenCalled();
    expect(getAuthenticated).not.toHaveBeenCalled();
  });

  it('terminalParked logs a structured park payload with reason, decision, lane and blockedBehind (#3511)', async () => {
    const log = vi.fn<Log>();
    const outcome = await runIssue(
      { ...request, lane: 'app', blockedBehind: [2, 3] },
      overBudget,
      parkingPorts(log, commentOctokit().octokit),
    );
    expect(outcome).toMatchObject({ state: 'parked', reason: 'fail' });
    expect(log).toHaveBeenCalledWith(
      'fail',
      expect.any(String),
      expect.objectContaining({
        park: {
          reason: 'fail',
          decision: parkUnblockHint('fail', workKeyFromIssue(1)),
          lane: 'app',
          blockedBehind: [2, 3],
        },
      }),
    );
  });

  it('logs the design-smell finding on the park payload, comment and outcome (#1513)', async () => {
    const F = { approachTried: 'cache it', whyItStinks: 'stale reads', recommendation: 'split the module' };
    vi.mocked(buildPhase).mockRejectedValue(
      Object.assign(new Error('smell'), { outcome: { state: 'parked', reason: 'escalate', designSmell: F } }),
    );
    const log = vi.fn<Log>();
    const { octokit, createComment } = commentOctokit();
    const outcome = await runIssue(request, policy, ports(log, octokit));
    expect(outcome).toMatchObject({ state: 'parked', reason: 'escalate', designSmell: F });
    expect(log).toHaveBeenCalledWith(
      'escalate',
      expect.any(String),
      expect.objectContaining({ park: expect.objectContaining({ designSmell: F }) }),
    );
    const body = createComment.mock.calls[0][0].body;
    expect(body).toContain('cache it');
    expect(body).toContain('stale reads');
    expect(body).toContain('split the module');
  });

  it("defaults the park payload lane to '' and blockedBehind to [] when the request has neither (#3511)", async () => {
    const log = vi.fn<Log>();
    await runIssue(request, overBudget, parkingPorts(log, commentOctokit().octokit));
    expect(log).toHaveBeenCalledWith(
      'fail',
      expect.any(String),
      expect.objectContaining({
        park: { reason: 'fail', decision: parkUnblockHint('fail', workKeyFromIssue(1)), lane: '', blockedBehind: [] },
      }),
    );
  });

  it('parks blocked with no failure signature when a phase throws a blocked marker (#2315)', async () => {
    vi.mocked(buildPhase).mockRejectedValue(Object.assign(new Error('waiting on #9'), { parkReason: 'blocked' }));
    const log = vi.fn<Log>();
    const { octokit, createComment } = commentOctokit();
    const outcome = await runIssue(request, policy, ports(log, octokit));
    expect(outcome).toMatchObject({ state: 'parked', reason: 'blocked' });
    expect(outcome).not.toHaveProperty('failureSignature');
    expect(outcome).not.toHaveProperty('failingChecks');
    expect(log.mock.calls.map(([type]) => type)).toContain('blocked');
    expect(createComment.mock.calls[0][0].body).toContain('reason: blocked');
  });
});

describe('runIssue — WorkKey phase log identity (#3674)', () => {
  it('writes phase logs under issue-<n> from the run WorkKey and keeps the issue reference in park messages', async () => {
    const logsDir = join(breakerDir, 'work-key-logs');
    vi.mocked(planPhase).mockImplementation(async (opts) => {
      await opts.onWorkerResult?.({ model: 'm', output: 'planned', exitCode: 0, attempts: [] });
      return { ...PLAN_OK, ok: false, escalate: 'x', sliced: { sliceCount: 3 } };
    });
    const outcome = await runIssue({ ...request, issue: 42, logsDir }, policy, ports(vi.fn<Log>()));
    expect(outcome).toMatchObject({ state: 'escalated', reason: expect.stringContaining('issue #42 sliced into') });
    const runs = await readdir(join(logsDir, 'issue-42'));
    expect(runs).toHaveLength(1);
    expect(await readFile(join(logsDir, 'issue-42', runs[0], 'plan.log'), 'utf8')).toContain('planned');
  });
});
