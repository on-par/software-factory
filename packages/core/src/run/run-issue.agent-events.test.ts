import { join } from 'node:path';

import type { Octokit } from '@octokit/rest';
import { afterAll, describe, expect, it } from 'vitest';

import type { AgentEvent } from '../harness/agent-events.js';
import { createTempDirs } from '../harness/temp-dir.js';
import { ProviderBreaker } from '../router/breaker.js';
import { ModelRouter } from '../router/index.js';
import { StubModelExecutor } from '../router/stub.js';
import { makeStubModelsConfig, makeStubRoutesConfig } from '../test-support/index.js';
import type { RunPolicy } from './policy.js';
import type { Workspace } from './ports.js';
import { runIssue, type RunPorts, type RunRequest } from './run-issue.js';

const tmp = createTempDirs();
afterAll(() => tmp.cleanup());

const EVENT: AgentEvent = {
  phase: 'plan',
  kind: 'tool_call',
  name: 'Bash',
  summary: 'ls',
  at: '2026-01-01T00:00:00.000Z',
};

function fixtures() {
  const models = makeStubModelsConfig();
  const routes = makeStubRoutesConfig();
  const request = {
    issue: 7,
    repo: 'acme/widgets',
    branch: 'issue-7-events',
    specPath: '/tmp/wt/spec.md',
    work: {
      id: 'github-issue:acme/widgets#7',
      kind: 'github-issue',
      title: 'Stream',
      brief: 'b',
      acceptanceCriteria: [],
    },
    startedAt: '2026-02-02T00:00:00.000Z',
    options: { interactive: false, autoRework: false, approvePlan: false, sandboxDisabled: true },
    timeouts: { plan: 30, build: 30, check: 30, approval: 30, tests: 30 },
    modelPins: { sources: {} },
    codexDisabled: true,
    skipCI: true,
    failover: { enabled: false, cooldownMs: 1, fallbackModel: 'stub-model' },
    efficiency: { maxReworkRounds: 0, fastPath: false },
    processGroupGraceMs: 10,
  } as RunRequest;
  const policy = {
    models,
    routes,
    sandbox: {
      enabled: false,
      runtime: 'auto',
      network: { allow: [] },
      resources: { cpuMs: 1000, memMb: 512 },
      docker: { rolloutPercent: 0 },
    },
    budget: {},
    effective: {} as RunPolicy['effective'],
  } as RunPolicy;
  return { models, routes, request, policy };
}

describe('runIssue agent events (#4246)', () => {
  it('appends agent events to the run log and calls onAgentEvent during a run', async () => {
    const { models, routes, request, policy } = fixtures();
    const stub = new StubModelExecutor({
      scripts: { plan: [{ output: 'planned', effect: (ctx) => ctx.onAgentEvent?.(EVENT) }] },
    });
    const logged: { phase?: string; type: string; msg: string }[] = [];
    const seen: AgentEvent[] = [];
    const ports = {
      router: new ModelRouter(models, routes, false, stub),
      octokit: {} as Octokit,
      workspace: { path: '/tmp/wt', dispose: async () => {} } as Workspace,
      events: (phase?: string) => (type: string, msg: string) => void logged.push({ phase, type, msg }),
      onAgentEvent: (e: AgentEvent) => void seen.push(e),
      breaker: new ProviderBreaker(join(tmp.makeSync('agent-events-'), 'breaker.json')),
      resolveConstitution: () => null,
      planPhase: async (opts) => {
        await opts.router.run('plan', 'p', { worktree: '/tmp/wt', timeoutSeconds: 30 });
        return {
          ok: false,
          route: 'codex',
          specPath: '/tmp/wt/spec.md',
          model: 'm',
          escalate: 'stop',
          designArtifact: null,
        };
      },
    } as RunPorts;
    const outcome = await runIssue(request, policy, ports);
    expect(outcome.state).toBe('escalated');
    const agentRows = logged.filter((row) => row.type === 'agent-event');
    expect(agentRows.map((row) => row.phase)).toEqual(['plan']);
    expect(JSON.parse(agentRows[0]!.msg)).toEqual(EVENT);
    expect(seen).toEqual([EVENT]);
  });
});
