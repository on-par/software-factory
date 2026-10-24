import { workKeyFromIssue } from '../work/work-key.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Octokit } from '@octokit/rest';
import { afterAll, describe, expect, it, vi } from 'vitest';

import { checkInfraParkMessage } from '../checkers/triage.js';
import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { createTempDirs } from '../harness/temp-dir.js';
import type { BuildResult } from '../phases/build.js';
import { checkPhase as realCheckPhase } from '../phases/check.js';
import type { PlanResult } from '../phases/plan.js';
import { ProviderBreaker } from '../router/breaker.js';
import { ModelRouter } from '../router/index.js';
import type { CheckSummary } from '../types/index.js';
import type { WorkRequest } from '../work/index.js';
import { parkUnblockHint } from './park-comment.js';
import type { RunPolicy } from './policy.js';
import type { Workspace } from './ports.js';
import { runIssue, type RunPorts, type RunRequest } from './run-issue.js';

const tempDirs = createTempDirs();
afterAll(() => tempDirs.cleanup());

const MODELS: ModelsConfig = {
  version: 1,
  models: {},
  tiers: {},
  failover: { triggers: [], maxRetries: 0, cooldownMs: 0 },
  routingRules: {},
};
const ROUTES: RoutesConfig = { version: 1, routes: {} };
const WORK: WorkRequest = {
  id: 'github-issue:o/r#1',
  kind: 'github-issue',
  title: 'Fix the thing',
  brief: 'do the thing',
  acceptanceCriteria: [],
};
const request: RunRequest = {
  issue: workKeyFromIssue(1),
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
  localOnly: true,
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
const PLAN_OK: PlanResult = { ok: true, route: 'codex', specPath: '/tmp/wt/spec.md', model: 'm', designArtifact: null };
const BUILD_OK: BuildResult = { ok: true, model: 'm', route: 'codex' };

type Log = ReturnType<RunPorts['events']>;

const ECONNRESET_SUMMARY: CheckSummary = {
  failures: 1,
  passes: 0,
  skips: 0,
  total: 1,
  results: [{ checker: 'tests', result: 'FAIL', details: 'boom\nread ECONNRESET\nat x' }],
};

function ports(log: Log, worktree: string, checkPhase: RunPorts['checkPhase']): RunPorts {
  return {
    router: new ModelRouter(MODELS, ROUTES),
    octokit: {} as Octokit,
    workspace: { path: worktree, dispose: async () => {} } as Workspace,
    events: () => log,
    breaker: new ProviderBreaker(join(tempDirs.makeSync('check-infra-breaker-'), 'breaker.json')),
    resolveConstitution: () => null,
    planPhase: vi.fn().mockResolvedValue(PLAN_OK),
    shipPhase: vi.fn(),
    buildPhase: vi.fn().mockResolvedValue(BUILD_OK),
    checkPhase,
  };
}

describe('runIssue — check-infra park (#3371)', () => {
  it('a repeated ECONNRESET in CHECK parks check-infra with the matching line', async () => {
    const worktree = tempDirs.makeSync('check-infra-park-');
    await mkdir(join(worktree, 'scripts'), { recursive: true });
    await writeFile(join(worktree, 'scripts', 'verify.sh'), '#!/usr/bin/env bash\n');
    const log = vi.fn<Log>();
    const runCheckers = vi.fn(async () => ECONNRESET_SUMMARY);
    const checkPhase: RunPorts['checkPhase'] = (o) =>
      realCheckPhase({
        ...o,
        worktree,
        runCheckers: runCheckers as never,
        runEvidence: vi.fn().mockResolvedValue(undefined) as never,
      });

    const outcome = await runIssue(request, policy, ports(log, worktree, checkPhase));

    expect(outcome).toMatchObject({ state: 'parked', reason: 'check-infra' });
    expect(runCheckers).toHaveBeenCalledTimes(2);
    const parked = log.mock.calls.find(([kind]) => kind === 'check-infra');
    expect(parked?.[1]).toContain(checkInfraParkMessage('tests', 'read ECONNRESET'));
  });

  it('has a park hint naming the infrastructure cause', () => {
    const hint = parkUnblockHint('check-infra', workKeyFromIssue(7));
    expect(hint).toContain('infrastructure');
    expect(hint).toContain('factory unpark 7');
  });
});
