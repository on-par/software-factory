import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { parseDecompositionOutput } from '../readiness/decompose.js';
import { renderSlicePlanComment, slicePlanFromDecomposition } from '../readiness/slice-plan.js';
import { ModelRouter } from '../router/index.js';
import { planPhase } from './plan.js';
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
  },
  tiers: { boss: ['stub-model'] },
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

const tempDirs = new Set<string>();

afterEach(async () => {
  await Promise.all([...tempDirs].map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.clear();
});

const BOT = 42;

const oversizedBody = `## Problem statement
The import queue stalls under load and loses jobs.

## In scope
- Item 1
- Item 2
- Item 3
- Item 4
- Item 5
- Item 6

## Out of scope
Changing the queue API.

## Acceptance criteria
- [ ] Criterion 1
- [ ] Criterion 2
- [ ] Criterion 3
- [ ] Criterion 4
- [ ] Criterion 5
- [ ] Criterion 6

## Verification
npm run test`;

const storyJson = (n: number) => ({
  title: `Story ${n}`,
  role: 'operator',
  want: `thing ${n} works`,
  soThat: 'value',
  problemStatement: `Problem for slice ${n}`,
  inScope: [`Scope ${n}`],
  outOfScope: ['Persistent storage'],
  acceptanceCriteria: [{ name: `ac ${n}`, given: [], when: ['run'], then: ['works'] }],
  verification: [{ command: 'npm test', passWhen: 'passes' }],
  tracesTo: ['INT-PROBLEM-01'],
});

const planComment = () => {
  const stories = [1, 2].map(storyJson);
  const parsed = parseDecompositionOutput(
    JSON.stringify({
      epic: { title: 'Epic', why: 'why', doneWhen: ['done'], children: stories.map((s) => s.title) },
      stories,
    }),
  );
  if (!parsed.ok) throw new Error(parsed.reason);
  const built = slicePlanFromDecomposition(607, parsed.decomposition);
  if (!built.ok) throw new Error(built.reason);
  return renderSlicePlanComment(built.plan);
};

async function run(opts: { mode: 'slice' | 'stack'; sliceIndex?: number }) {
  const worktree = await mkdtemp(join(tmpdir(), 'plan-stack-slice-test-'));
  tempDirs.add(worktree);
  const stub = new StubModelExecutor({ scripts: { plan: [{ output: specWithDesign('Spec') }] } });
  const router = new ModelRouter(models, routes, false, stub);
  const messages: string[] = [];
  const result = await planPhase({
    issue: 607,
    repo: 'on-par/software-factory',
    worktree,
    specPath: join(worktree, 'issue-607.md'),
    router,
    constitution: null,
    octokit: {
      rest: {
        users: { getAuthenticated: async () => ({ data: { id: BOT } }) },
        issues: {
          get: async () => ({ data: { title: 'Harden the import queue', body: oversizedBody } }),
          listComments: async () => ({ data: [{ id: 1, user: { id: BOT }, body: planComment() }] }),
          createComment: vi.fn(),
          updateComment: vi.fn(),
          addLabels: vi.fn().mockResolvedValue({}),
        },
      },
      request: vi.fn().mockResolvedValue({ data: [] }),
    } as any,
    log: (_type, msg) => messages.push(msg),
    sizeGateMode: opts.mode,
    sliceIndex: opts.sliceIndex,
  });
  const prompt = stub.calls.find((call) => call.task === 'plan')?.prompt ?? '';
  return { result, stub, prompt, messages };
}

describe('planPhase sliceIndex (ADR-0161 stack mode)', () => {
  it('stack mode plans the explicit sliceIndex instead of the current slice', async () => {
    const { result, stub, prompt } = await run({ mode: 'stack', sliceIndex: 2 });
    expect(result.ok).toBe(true);
    expect(stub.calls.map((call) => call.task)).toEqual(['plan']);
    expect(prompt).toContain('Problem for slice 2');
    expect(prompt).not.toContain('Problem for slice 1');
    expect(result.slice?.index).toBe(2);
  });

  it('stack mode without sliceIndex plans the current slice and logs no stale line', async () => {
    const { result, prompt, messages } = await run({ mode: 'stack' });
    expect(result.ok).toBe(true);
    expect(prompt).toContain('Problem for slice 1');
    expect(result.slice?.index).toBe(1);
    expect(messages.some((m) => m.includes('not built yet'))).toBe(false);
  });

  it('slice mode ignores sliceIndex and plans the current slice', async () => {
    const { result, prompt } = await run({ mode: 'slice', sliceIndex: 2 });
    expect(result.ok).toBe(true);
    expect(prompt).toContain('Problem for slice 1');
    expect(prompt).not.toContain('Problem for slice 2');
    expect(result.slice?.index).toBe(1);
  });

  it('stack mode parks when sliceIndex is not in the slice plan', async () => {
    const { result, stub } = await run({ mode: 'stack', sliceIndex: 5 });
    expect(result.ok).toBe(false);
    expect(result.escalate).toContain('slice 5 is not in the slice plan');
    expect(stub.calls.map((call) => call.task)).not.toContain('plan');
  });
});
