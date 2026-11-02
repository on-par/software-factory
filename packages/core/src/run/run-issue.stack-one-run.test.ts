// packages/core/src/run/run-issue.stack-one-run.test.ts — a 3-slice stack builds in one run through the real
// PLAN slice gate; only GitHub, the model executor and BUILD/CHECK/SHIP are faked (#3798).
import { join } from 'node:path';

import { createTempDirs } from '@on-par/factory-core/testing';
import { afterAll, describe, expect, it, vi } from 'vitest';

import type { RoutesConfig } from '../config/index.js';
import { specWithDesign } from '../phases/plan-test-helpers.js';
import {
  parseSlicePlanComment,
  renderSlicePlanComment,
  stackSliceBranch,
  type SlicePlan,
} from '../readiness/slice-plan.js';
import { ProviderBreaker } from '../router/breaker.js';
import { ModelRouter } from '../router/index.js';
import { StubModelExecutor } from '../router/stub.js';
import { fakeOctokit, stubModel } from '../test-support/index.js';
import type { RunOutcome } from './outcome.js';
import type { RunPolicy } from './policy.js';
import type { Workspace } from './ports.js';
import { runIssue, type RunRequest } from './run-issue.js';
import { runStack } from './stack-engine.js';

const BOT = 7;
const ISSUE = 1;
const ISSUE_BODY = `## Problem statement
The import queue stalls under load.

## In scope
- Item 1

## Out of scope
Changing the queue API.

## Acceptance criteria
- [ ] Criterion 1

## Verification
npm run test`;

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
const freshPlan = (): SlicePlan => ({
  issue: ISSUE,
  slices: [1, 2, 3].map((n) => ({ index: n, title: `S${n}`, story: story(n) as never, state: 'pending' as const })),
});
const branch = (k: number) => stackSliceBranch(ISSUE, k);

/** GitHub as the gate sees it: one issue whose comments are read back as they are written. */
function fakeGitHub() {
  const comments = [{ id: 1, user: { id: BOT }, body: renderSlicePlanComment(freshPlan()) }];
  const { octokit } = fakeOctokit({
    'users.getAuthenticated': { data: { id: BOT } },
    'issues.get': { data: { title: 'Harden the import queue', body: ISSUE_BODY, labels: [] } },
    'issues.listComments': () => ({ data: comments }),
    'issues.createComment': (a: { body: string }) => {
      comments.push({ id: comments.length + 1, user: { id: BOT }, body: a.body });
      return { data: { id: comments.length } };
    },
    'issues.updateComment': (a: { comment_id: number; body: string }) => {
      comments.find((c) => c.id === a.comment_id)!.body = a.body;
      return { data: {} };
    },
    'issues.addLabels': { data: {} },
  });
  octokit.request = vi.fn(async () => ({ data: [] }));
  const plan = () => {
    const parsed = parseSlicePlanComment(comments[0]!.body);
    if (parsed?.ok !== true) throw new Error('slice plan comment unreadable');
    return parsed.plan;
  };
  return { octokit, plan };
}

const routes: RoutesConfig = {
  version: 1,
  routes: {
    plan: { tier: 'boss', description: 'stub' },
    build_codex: { tier: 'worker', description: 'stub', requires: 'codex' },
  },
};

const dirs = createTempDirs();
const breakerDir = dirs.makeSync('run-issue-stack-one-run-');
afterAll(() => dirs.cleanup());

function request(parentBaseRef: string | undefined): RunRequest {
  return {
    issue: ISSUE,
    repo: 'o/r',
    branch: 'issue-1-harden',
    specPath: join(breakerDir, 'spec.md'),
    work: { id: 'github-issue:o/r#1', kind: 'github-issue', title: 'Harden', brief: 'b', acceptanceCriteria: [] },
    startedAt: '2026-01-01T00:00:00.000Z',
    options: { interactive: false, autoRework: true, approvePlan: false, sandboxDisabled: false },
    timeouts: { plan: 60, build: 60, check: 60, approval: 60, tests: 60 },
    modelPins: { sources: {} },
    codexDisabled: false,
    skipCI: false,
    failover: { enabled: false, cooldownMs: 60_000, fallbackModel: 'claude-sonnet-5' },
    efficiency: { maxReworkRounds: 1, fastPath: false },
    processGroupGraceMs: 50,
    sizeGateMode: 'stack',
    ...(parentBaseRef !== undefined ? { parentBaseRef } : {}),
  };
}

describe('run-issue --stack through the real slice gate (#3798)', () => {
  it("builds slices 1, 2 and 3 in one run, each on the previous slice's branch, never released", async () => {
    const github = fakeGitHub();
    const models = {
      version: 1 as const,
      models: { 'stub-model': stubModel() },
      tiers: { boss: ['stub-model'] },
      failover: { triggers: [], maxRetries: 0, cooldownMs: 0 },
      routingRules: {},
    };
    const executor = new StubModelExecutor({
      scripts: { plan: [1, 2, 3].map((k) => ({ output: specWithDesign(`Slice ${k}`) })) },
    });
    const policy: RunPolicy = {
      models,
      routes,
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
    const createSliceBranch = vi.fn(async (_o: { branch: string; startPoint: string }) => {});
    let pr = 100;
    const shipPhase = vi.fn(async () => ({ ok: true, prNumber: ++pr }));
    const ports = {
      router: new ModelRouter(models, routes, false, executor),
      octokit: github.octokit,
      workspace: { path: breakerDir, dispose: async () => {} } as Workspace,
      events: () => vi.fn(),
      breaker: new ProviderBreaker(join(breakerDir, 'breaker.json')),
      resolveConstitution: () => null,
      buildPhase: vi.fn(async () => ({ ok: true, model: 'm', route: 'codex' as const })),
      checkPhase: vi.fn(async () => ({
        passed: true,
        summary: { failures: 0, passes: 1, skips: 0, total: 1, results: [] },
        reworkRounds: 0,
      })),
      shipPhase: shipPhase as never,
      createSliceBranch,
    };
    const outcomes: RunOutcome[] = [];

    const result = await runStack(
      [1, 2, 3].map((k) => ({
        title: `slice ${k}/3`,
        run: async (base: string | undefined) => {
          const o = await runIssue(request(base && `origin/${base}`), policy, ports);
          outcomes.push(o);
          return { prNumber: 'prNumber' in o ? o.prNumber : undefined, branch: o.branch };
        },
      })),
      { chain: true, prefix: 'run-issue', noun: 'slice', log: () => {} },
    );

    expect(outcomes.map((o) => o.state)).toEqual(['ready', 'ready', 'ready']);
    expect(outcomes.some((o) => o.state === 'released')).toBe(false);
    expect(result.ok).toBe(true);
    const planned = executor.calls.filter((c) => c.task === 'plan').map((c) => /Problem (\d)/.exec(c.prompt)?.[1]);
    expect(planned).toEqual(['1', '2', '3']);
    expect(createSliceBranch.mock.calls.map((c) => [c[0].branch, c[0].startPoint])).toEqual([
      [branch(1), 'origin/main'],
      [branch(2), branch(1)],
      [branch(3), branch(2)],
    ]);
    expect(github.plan().slices.map((s) => [s.state, s.branch, s.prNumber])).toEqual([
      ['pr-open', branch(1), 101],
      ['pr-open', branch(2), 102],
      ['pr-open', branch(3), 103],
    ]);
  });
});
