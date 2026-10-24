import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { createTempDirs } from '../harness/temp-dir.js';
import { ModelRouter } from '../router/index.js';
import { buildPlanPrompt, planPhase } from './plan.js';
import { specWithDesign, StubModelExecutor } from './plan-test-helpers.js';

const models: ModelsConfig = {
  version: 1,
  models: {
    'stub-model': {
      provider: 'custom',
      tier: 'boss',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
    },
    'pinned-model': {
      provider: 'custom',
      tier: 'boss',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
    },
  },
  tiers: { boss: ['stub-model', 'pinned-model'] },
  failover: {
    triggers: ['rate_limit', 'unavailable', 'auth'],
    maxRetries: 2,
    cooldownMs: 0,
  },
  routingRules: {},
};

const routes: RoutesConfig = {
  version: 1,
  routes: {
    plan: { tier: 'boss', description: 'stub' },
    readiness_enrich: { tier: 'boss', description: 'stub' },
    decompose: { tier: 'boss', description: 'stub' },
  },
};

describe('buildPlanPrompt agent memory (#3624)', () => {
  it('buildPlanPrompt output is unchanged when agentMemoryCtx is empty', () => {
    const base = {
      issue: 36,
      issueTitle: 'Add eval runner',
      issueBody: 'Measure the current prompt.',
      specPath: '/tmp/spec.md',
      constitutionCtx: '',
    };
    expect(buildPlanPrompt({ ...base, agentMemoryCtx: '' })).toBe(buildPlanPrompt(base));
    const withMemory = buildPlanPrompt({ ...base, agentMemoryCtx: '## Lane memory (a)\n\nhi\n' });
    expect(withMemory.indexOf('## Lane memory (a)')).toBeLessThan(withMemory.indexOf('## Issue #36'));
  });
});

describe('planPhase agent memory (#3624)', () => {
  const issueBody = `## Problem statement
Queue stalls.
## In scope
Repair it.
## Out of scope
API.
## Acceptance criteria
- [ ] Done.
## Verification
npm test`;

  const tmp = createTempDirs();

  async function runLane(memory: { lane: string; content: string } | null, laneId: string | undefined) {
    const worktree = await tmp.make('plan-phase-test-');
    try {
      if (memory) {
        await mkdir(join(worktree, '.factory/agent-memory'), { recursive: true });
        await writeFile(join(worktree, `.factory/agent-memory/${memory.lane}.md`), memory.content);
      }
      const stub = new StubModelExecutor({ scripts: { plan: [{ output: specWithDesign('Spec') }] } });
      const router = new ModelRouter(models, routes, false, stub);
      const logs: { type: string; msg: string }[] = [];
      await planPhase({
        issue: 7,
        repo: 'on-par/software-factory',
        worktree,
        specPath: join(worktree, 'issue-7.md'),
        router,
        constitution: null,
        octokit: { rest: { issues: { get: async () => ({ data: { title: 'T', body: issueBody } }) } } } as any,
        log: (type, msg) => logs.push({ type, msg }),
        laneId,
      });
      return { prompt: stub.calls.find((c) => c.task === 'plan')?.prompt ?? '', logs };
    } finally {
      await tmp.cleanup();
    }
  }

  it("planPhase includes the lane's agent memory file in the PLAN prompt", async () => {
    const { prompt, logs } = await runLane({ lane: 'alpha', content: 'ALPHA-PITFALL-XYZ' }, 'alpha');
    expect(prompt).toContain('ALPHA-PITFALL-XYZ');
    expect(logs.some((l) => l.type === 'agent_memory_loaded')).toBe(true);
  });

  it("planPhase does not include lane A's agent memory in lane B's PLAN prompt", async () => {
    const { prompt, logs } = await runLane({ lane: 'alpha', content: 'ALPHA-PITFALL-XYZ' }, 'beta');
    expect(prompt).not.toContain('ALPHA-PITFALL-XYZ');
    expect(logs.some((l) => l.type.startsWith('agent_memory'))).toBe(false);
  });

  it('planPhase ignores an oversized agent memory file and logs agent_memory_oversized', async () => {
    const { prompt, logs } = await runLane({ lane: 'alpha', content: `BIG${'x'.repeat(5000)}` }, 'alpha');
    expect(prompt).not.toContain('BIG');
    expect(logs.some((l) => l.type === 'agent_memory_oversized')).toBe(true);
  });
});
