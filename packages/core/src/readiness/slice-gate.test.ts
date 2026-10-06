import type { Octokit } from '@octokit/rest';
import { describe, expect, it, vi } from 'vitest';

import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { ModelRouter } from '../router/index.js';
import { StubModelExecutor } from '../router/stub.js';
import { parseDecompositionOutput } from './decompose.js';
import { resolveSliceGate } from './slice-gate.js';
import { SLICE_PLAN_MARKER, renderSlicePlanComment, slicePlanFromDecomposition, withSliceState } from './slice-plan.js';
import type { SlicePlan } from './slice-plan.js';

const BOT = 42;
const repo = 'acme/widgets';
const issue = 5;

const models: ModelsConfig = {
  version: 1,
  models: {
    'stub-model': {
      provider: 'custom',
      tier: 'triage',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
    },
  },
  tiers: { triage: ['stub-model'] },
  failover: {
    triggers: ['rate_limit', 'usage_cap', 'timeout', 'error', 'empty_response'],
    maxRetries: 2,
    cooldownMs: 0,
    escalateAfterTierExhausted: true,
  },
  routingRules: {},
};

const routes: RoutesConfig = {
  version: 1,
  routes: {
    decompose: { tier: 'triage', description: 'stub' },
  },
};

function storyJson(n: number) {
  return {
    title: `Story ${n}`,
    role: 'operator',
    want: `thing ${n} works`,
    soThat: 'value',
    problemStatement: `Problem ${n}`,
    inScope: [`scope ${n}`],
    outOfScope: ['other'],
    acceptanceCriteria: [{ name: `ac ${n}`, given: [], when: ['run'], then: ['works'] }],
    verification: [{ command: 'npm test', passWhen: 'passes' }],
    tracesTo: ['INT-PROBLEM-01'],
  };
}

function decompositionJson(count: number): string {
  const stories = Array.from({ length: count }, (_, i) => storyJson(i + 1));
  return JSON.stringify({
    epic: { title: 'Epic', why: 'why', doneWhen: ['done'], children: stories.map((s) => s.title) },
    stories,
  });
}

function planOf(count: number): SlicePlan {
  const parsed = parseDecompositionOutput(decompositionJson(count));
  if (!parsed.ok) throw new Error(parsed.reason);
  const built = slicePlanFromDecomposition(issue, parsed.decomposition);
  if (!built.ok) throw new Error(built.reason);
  return built.plan;
}

function fake(comments: { id: number; user: { id: number } | null; body?: string }[], opts?: { listThrows?: boolean }) {
  const getAuthenticated = vi.fn().mockResolvedValue({ data: { id: BOT } });
  const listComments = vi.fn(async () => {
    if (opts?.listThrows) throw new Error('github down');
    return { data: comments };
  });
  const createComment = vi.fn().mockResolvedValue({ data: { id: 9999 } });
  const updateComment = vi.fn().mockResolvedValue({ data: {} });
  const octokit = Object.assign({} as Octokit, {
    rest: { users: { getAuthenticated }, issues: { listComments, createComment, updateComment } },
  });
  return { octokit, createComment, updateComment };
}

function setup(decompose: string[], f: ReturnType<typeof fake>, oversized = true) {
  const stub = new StubModelExecutor({ scripts: { decompose: decompose.map((output) => ({ output })) } });
  const router = new ModelRouter(models, routes, false, stub);
  const events: { type: string; msg: string }[] = [];
  const run = () =>
    resolveSliceGate({
      issue,
      repo,
      title: 'Big issue',
      body: 'body',
      oversized,
      sizeReason: 'too many items',
      worktree: '/tmp/wt',
      router,
      octokit: f.octokit,
      log: (type, msg) => events.push({ type, msg }),
    });
  return { stub, events, run };
}

describe('resolveSliceGate', () => {
  it('reuses a trusted plan: first non-merged slice, no decompose call', async () => {
    const plan = withSliceState(planOf(2), 1, 'merged');
    const f = fake([{ id: 1, user: { id: BOT }, body: renderSlicePlanComment(plan) }]);
    const { stub, run } = setup([], f);

    const outcome = await run();

    expect(outcome).toMatchObject({ kind: 'slice', created: false });
    expect(outcome.kind === 'slice' && outcome.slice.index).toBe(2);
    expect(stub.calls).toEqual([]);
    expect(f.createComment).not.toHaveBeenCalled();
  });

  it('parks when the trusted marker comment is unreadable', async () => {
    const f = fake([{ id: 77, user: { id: BOT }, body: `${SLICE_PLAN_MARKER}\n<!-- factory:slice-plan-data !!! -->` }]);
    const { stub, run } = setup([], f);

    const outcome = await run();

    expect(outcome).toMatchObject({ kind: 'park', reason: expect.stringContaining('comment 77 on #5 is unreadable') });
    expect(stub.calls).toEqual([]);
  });

  it('parks when the lookup throws', async () => {
    const f = fake([], { listThrows: true });
    const { run } = setup([], f);
    expect(await run()).toEqual({ kind: 'park', reason: 'slice plan lookup failed: github down' });
  });

  it('parks when every slice is merged', async () => {
    let plan = planOf(2);
    plan = withSliceState(withSliceState(plan, 1, 'merged'), 2, 'merged');
    const f = fake([{ id: 1, user: { id: BOT }, body: renderSlicePlanComment(plan) }]);
    const { run } = setup([], f);
    expect(await run()).toMatchObject({ kind: 'park', reason: expect.stringContaining('every slice') });
  });

  it('returns none without a model call when not found and not oversized', async () => {
    const f = fake([]);
    const { stub, run } = setup([], f, false);
    expect(await run()).toEqual({ kind: 'none' });
    expect(stub.calls).toEqual([]);
  });

  it('decomposes once and creates the slice plan comment (the only comment)', async () => {
    const f = fake([]);
    const { stub, events, run } = setup([decompositionJson(2)], f);

    const outcome = await run();

    expect(outcome).toMatchObject({ kind: 'slice', created: true });
    expect(outcome.kind === 'slice' && outcome.slice.index).toBe(1);
    expect(stub.calls.map((c) => c.task)).toEqual(['decompose']);
    expect(f.createComment).toHaveBeenCalledTimes(1);
    expect(f.createComment.mock.calls[0][0].body.startsWith(SLICE_PLAN_MARKER)).toBe(true);
    expect(f.createComment.mock.calls[0][0].body).not.toContain('## Proposed epic');
    expect(events.map((e) => e.type)).toContain('size-gate-sliced');
  });

  it('falls back to file mode for more than 5 stories, posting nothing', async () => {
    const f = fake([]);
    const { run } = setup([decompositionJson(6)], f);
    expect(await run()).toMatchObject({ kind: 'fallback-file', storyCount: 6 });
    expect(f.createComment).not.toHaveBeenCalled();
  });

  it('parks when the decomposition fails INVEST twice', async () => {
    const bad = JSON.stringify({
      epic: { title: 'E', why: 'w', doneWhen: ['d'], children: ['S'] },
      stories: [{ ...storyJson(1), outOfScope: ['x'], want: 'depends on other work', tracesTo: [] }],
    });
    const f = fake([]);
    const { run } = setup([bad, bad], f);
    expect(await run()).toMatchObject({ kind: 'park', reason: expect.stringContaining('slice decomposition failed') });
    expect(f.createComment).not.toHaveBeenCalled();
  });

  it('parks when posting the plan throws', async () => {
    const f = fake([]);
    f.createComment.mockRejectedValue(new Error('403'));
    const { run } = setup([decompositionJson(2)], f);
    expect(await run()).toEqual({ kind: 'park', reason: 'posting the slice plan failed: 403' });
  });
});
