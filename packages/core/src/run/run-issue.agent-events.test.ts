import { join } from 'node:path';

import type { Octokit } from '@octokit/rest';
import { afterAll, describe, expect, it } from 'vitest';

import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import type { AgentEvent } from '../harness/agent-events.js';
import type { planPhase as realPlanPhase } from '../phases/plan.js';
import { createTempDirs } from '../harness/temp-dir.js';
import { ProviderBreaker } from '../router/breaker.js';
import { ModelRouter } from '../router/index.js';
import { StubModelExecutor } from '../router/stub.js';
import type { RunPolicy } from './policy.js';
import type { Workspace } from './ports.js';
import { runIssue, type RunPorts, type RunRequest } from './run-issue.js';

const request: RunRequest = {
  repo: 'acme/widgets',
  issue: 7,
  work: {
    kind: 'github-issue',
    id: 'github-issue:acme/widgets#7',
    brief: 'stream it',
    title: 'Stream agent events',
    acceptanceCriteria: [],
  },
  branch: 'issue-7-stream',
  specPath: '/tmp/wt/spec.md',
  codexDisabled: false,
  skipCI: false,
  processGroupGraceMs: 10,
  startedAt: '2026-02-02T00:00:00.000Z',
  modelPins: { sources: {} },
  efficiency: { fastPath: false, maxReworkRounds: 0 },
  timeouts: { tests: 5, approval: 5, check: 5, build: 5, plan: 5 },
  options: { approvePlan: false, interactive: false, sandboxDisabled: false, autoRework: false },
  failover: { fallbackModel: 'claude-sonnet-5', cooldownMs: 1, enabled: false },
};

const MODELS_WITH_WORKER: ModelsConfig = {
  version: 1,
  failover: { maxRetries: 0, triggers: [], cooldownMs: 0 },
  routingRules: {},
  tiers: { worker: ['w'] },
  models: {
    w: {
      provider: 'custom',
      tier: 'worker',
      envKey: null,
      capabilities: [],
      contextWindow: 1000,
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
    },
  },
};
const PLAN_ROUTES: RoutesConfig = { version: 1, routes: { plan: { tier: 'worker', description: 'stub' } } };

const policy: RunPolicy = {
  budget: {},
  effective: {} as RunPolicy['effective'],
  models: MODELS_WITH_WORKER,
  routes: PLAN_ROUTES,
  sandbox: {
    docker: { rolloutPercent: 0 },
    resources: { memMb: 0, cpuMs: 0 },
    network: { allow: [] },
    runtime: 'auto',
    enabled: false,
  },
};

const tmp = createTempDirs();
afterAll(() => tmp.cleanup());

describe('runIssue agent events', () => {
  it('appends agent events to the run log and calls onAgentEvent during a run', async () => {
    const event: AgentEvent = {
      phase: 'plan',
      kind: 'tool_call',
      name: 'Read',
      summary: 'a.ts',
      at: '2026-01-01T00:00:00.000Z',
    };
    const stub = new StubModelExecutor({
      scripts: { plan: [{ output: 'PLAN', effect: (ctx) => ctx.onAgentEvent?.(event) }] },
    });
    const router = new ModelRouter(MODELS_WITH_WORKER, PLAN_ROUTES, false, stub);
    const logged: { phase: string | undefined; type: string; msg: string }[] = [];
    const received: AgentEvent[] = [];
    const planPhase: typeof realPlanPhase = async (opts) => {
      await opts.router.run('plan', 'prompt', { worktree: opts.worktree });
      return {
        ok: false,
        route: 'codex',
        specPath: opts.specPath,
        model: 'w',
        escalate: 'stop here',
        designArtifact: null,
      };
    };
    const ports: RunPorts = {
      router,
      octokit: {} as Octokit,
      workspace: { path: '/tmp/wt', dispose: async () => {} } as Workspace,
      events: (phase) => (type, msg) => {
        logged.push({ phase, type, msg });
      },
      breaker: new ProviderBreaker(join(tmp.makeSync('run-issue-agent-events-'), 'breaker.json')),
      resolveConstitution: () => null,
      planPhase,
      onAgentEvent: (e) => received.push(e),
    };

    const outcome = await runIssue(request, policy, ports);

    expect(outcome).toMatchObject({ state: expect.stringMatching(/parked|escalated/) });
    const agentRows = logged.filter((l) => l.type === 'agent-event');
    expect(agentRows.map((l) => l.phase)).toEqual(['plan']);
    expect(JSON.parse(agentRows[0].msg)).toEqual(event);
    expect(received).toEqual([event]);
  });
});
