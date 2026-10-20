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

function storyJson(n: number, files?: string[]) {
  return {
    ...(files === undefined ? {} : { filesLikelyTouched: files }),
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

function decompositionJson(count: number, filesFor?: (n: number) => string[]): string {
  const stories = Array.from({ length: count }, (_, i) => storyJson(i + 1, filesFor?.(i + 1)));
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

function setup(
  decompose: string[],
  f: ReturnType<typeof fake>,
  oversized = true,
  maxSlices = 10,
  sliceIndex?: number,
  stackMode?: boolean,
) {
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
      maxSlices,
      sliceIndex,
      stackMode,
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

  it('stack mode selects the next pending slice over a pr-open lower slice (#3367)', async () => {
    const plan = withSliceState(planOf(2), 1, 'pr-open', 81);
    const f = fake([{ id: 1, user: { id: BOT }, body: renderSlicePlanComment(plan) }]);
    const { run } = setup([], f, true, 10, undefined, true);
    const outcome = await run();
    expect(outcome.kind === 'slice' && outcome.slice.index).toBe(2);
  });

  it('parks without decomposing when the current slice already has an open PR', async () => {
    const plan = withSliceState(planOf(2), 1, 'pr-open', 81);
    const f = fake([{ id: 1, user: { id: BOT }, body: renderSlicePlanComment(plan) }]);
    const { stub, run } = setup([], f);
    expect(await run()).toMatchObject({ kind: 'park', reason: expect.stringContaining('PR #81') });
    expect(stub.calls).toEqual([]);
  });

  describe('explicit sliceIndex (ADR-0161 stack mode)', () => {
    const found = (plan: SlicePlan) => fake([{ id: 1, user: { id: BOT }, body: renderSlicePlanComment(plan) }]);

    it('selects the requested slice even when an earlier slice is pending', async () => {
      const { stub, run } = setup([], found(planOf(2)), true, 10, 2);
      const outcome = await run();
      expect(outcome).toMatchObject({ kind: 'slice', created: false });
      expect(outcome.kind === 'slice' && outcome.slice.index).toBe(2);
      expect(stub.calls).toEqual([]);
    });

    it('parks when the index is not in the plan', async () => {
      const { run } = setup([], found(planOf(2)), true, 10, 3);
      expect(await run()).toMatchObject({ kind: 'park', reason: expect.stringContaining('not in the slice plan') });
    });

    it('parks when the requested slice is merged', async () => {
      const { run } = setup([], found(withSliceState(planOf(2), 2, 'merged')), true, 10, 2);
      expect(await run()).toMatchObject({ kind: 'park', reason: expect.stringContaining('already merged') });
    });

    it('parks with the pr-open reason when the requested slice has an open PR', async () => {
      const { run } = setup([], found(withSliceState(planOf(2), 2, 'pr-open', 82)), true, 10, 2);
      expect(await run()).toMatchObject({ kind: 'park', reason: expect.stringContaining('PR #82') });
    });

    it('selects the requested slice of a newly created plan', async () => {
      const { run } = setup([decompositionJson(2)], fake([]), true, 10, 2);
      const outcome = await run();
      expect(outcome).toMatchObject({ kind: 'slice', created: true });
      expect(outcome.kind === 'slice' && outcome.slice.index).toBe(2);
    });
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

  it('records an over-cap plan and returns over-cap without logging size-gate-sliced', async () => {
    const f = fake([]);
    const { events, run } = setup([decompositionJson(6)], f, true, 5);
    const outcome = await run();
    expect(outcome).toMatchObject({ kind: 'over-cap', reason: expect.stringContaining('--max-slices 6') });
    expect(f.createComment).toHaveBeenCalledTimes(1);
    const body = f.createComment.mock.calls[0][0].body as string;
    expect(body.startsWith(SLICE_PLAN_MARKER)).toBe(true);
    expect(outcome.kind === 'over-cap' && outcome.plan.slices.every((s) => s.state === 'pending')).toBe(true);
    expect(events.map((e) => e.type)).not.toContain('size-gate-sliced');
  });

  it('parks without recording when the decomposition exceeds the ceiling of 20', async () => {
    const f = fake([]);
    const { run } = setup([decompositionJson(21)], f, true, 5);
    expect(await run()).toMatchObject({ kind: 'unsliceable', reason: expect.stringContaining('ceiling of 20') });
    expect(f.createComment).not.toHaveBeenCalled();
    expect(f.updateComment).not.toHaveBeenCalled();
  });

  it('parks a found all-pending plan over the cap without decomposing or rewriting', async () => {
    const f = fake([{ id: 1, user: { id: BOT }, body: renderSlicePlanComment(planOf(6)) }]);
    const { stub, run } = setup([], f, true, 5);
    expect(await run()).toMatchObject({ kind: 'over-cap', reason: expect.stringContaining('cap 5') });
    expect(stub.calls).toEqual([]);
    expect(f.createComment).not.toHaveBeenCalled();
    expect(f.updateComment).not.toHaveBeenCalled();
  });

  it('plans slice 1 of a found plan once the cap covers it', async () => {
    const f = fake([{ id: 1, user: { id: BOT }, body: renderSlicePlanComment(planOf(6)) }]);
    const { stub, run } = setup([], f, true, 6);
    const outcome = await run();
    expect(outcome).toMatchObject({ kind: 'slice', created: false });
    expect(outcome.kind === 'slice' && outcome.slice.index).toBe(1);
    expect(stub.calls).toEqual([]);
  });

  it('ignores the cap for a started plan', async () => {
    const plan = withSliceState(planOf(6), 1, 'merged');
    const f = fake([{ id: 1, user: { id: BOT }, body: renderSlicePlanComment(plan) }]);
    const { run } = setup([], f, true, 5);
    const outcome = await run();
    expect(outcome.kind === 'slice' && outcome.slice.index).toBe(2);
  });

  it("returns unsliceable with the slicer's reason when the decomposition fails INVEST twice", async () => {
    const bad = JSON.stringify({
      epic: { title: 'E', why: 'w', doneWhen: ['d'], children: ['S'] },
      stories: [{ ...storyJson(1), outOfScope: ['x'], want: 'depends on other work', tracesTo: [] }],
    });
    const f = fake([]);
    const { run } = setup([bad, bad], f);
    expect(await run()).toMatchObject({
      kind: 'unsliceable',
      reason: expect.stringMatching(/slice decomposition failed.*INVEST/),
    });
    expect(f.createComment).not.toHaveBeenCalled();
  });

  it('returns unsliceable with the parse error when the slicer output is not JSON', async () => {
    const f = fake([]);
    const { run } = setup(['not json', 'not json'], f);
    expect(await run()).toMatchObject({
      kind: 'unsliceable',
      reason: expect.stringContaining('no JSON object found in the model output'),
    });
    expect(f.createComment).not.toHaveBeenCalled();
  });

  it('parks when posting the plan throws', async () => {
    const f = fake([]);
    f.createComment.mockRejectedValue(new Error('403'));
    const { run } = setup([decompositionJson(2)], f);
    expect(await run()).toEqual({ kind: 'park', reason: 'posting the slice plan failed: 403' });
  });

  it('keeps an issue whole when every slice edits the same files', async () => {
    const f = fake([]);
    const same = ['src/list.ts', 'docs/list.md', 'src/list.test.ts'];
    const { events, run } = setup([decompositionJson(3, () => same)], f);

    const outcome = await run();

    expect(outcome.kind).toBe('cohesive');
    expect(f.createComment).not.toHaveBeenCalled();
    expect(f.updateComment).not.toHaveBeenCalled();
    const cohesive = events.find((e) => e.type === 'size_gate_cohesive');
    expect(cohesive?.msg).toContain('3 slice');
    expect(cohesive?.msg).toContain('src/list.ts');
    expect(events.map((e) => e.type)).not.toContain('size-gate-sliced');
  });

  it('records a slice plan when slices edit disjoint files', async () => {
    const f = fake([]);
    const names = ['a', 'b', 'c'];
    const { events, run } = setup(
      [decompositionJson(3, (n) => [`src/${names[n - 1]}.ts`, `src/${names[n - 1]}.test.ts`])],
      f,
    );

    const outcome = await run();

    expect(outcome.kind).toBe('slice');
    if (outcome.kind === 'slice') expect(outcome.created).toBe(true);
    expect(f.createComment).toHaveBeenCalledTimes(1);
    expect(events.map((e) => e.type)).toContain('size-gate-sliced');
  });
});
