import { join } from 'node:path';
import type { Octokit } from '@octokit/rest';
import { afterEach, expect, it } from 'vitest';
import { createTempDirs } from '../harness/temp-dir.js';
import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { parseDecompositionOutput } from '../readiness/decompose.js';
import { slicePlanFromDecomposition } from '../readiness/slice-plan.js';
import type { SlicePlanStore } from '../readiness/slice-plan-store.js';
import { ModelRouter } from '../router/index.js';
import { workKeyFromIssue } from '../work/work-key.js';
import { planPhase } from './plan.js';
import { StubModelExecutor } from './plan-test-helpers.js';

const models: ModelsConfig = {
  version: 1,
  models: {
    stub: {
      provider: 'custom',
      tier: 'boss',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
    },
  },
  tiers: { boss: ['stub'] },
  failover: { triggers: ['rate_limit', 'unavailable', 'auth'], maxRetries: 2, cooldownMs: 0 },
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
const body =
  '## Problem statement\nToo big.\n## In scope\n- one\n## Out of scope\n- rest\n## Acceptance criteria\n- [ ] works\n## Verification\nnpm test';
const story = (n: number) => ({
  title: 'Story ' + n,
  role: 'operator',
  want: 'feature ' + n,
  soThat: 'value',
  problemStatement: 'Problem ' + n,
  inScope: ['Scope ' + n],
  outOfScope: ['rest'],
  acceptanceCriteria: [{ name: 'Works', given: [], when: ['run'], then: ['works'], tracesTo: ['P1'] }],
  verification: [{ command: 'npm test', passWhen: 'passes' }],
  tracesTo: ['INT-PROBLEM-01'],
});
const decomposition = JSON.stringify({
  epic: { title: 'Epic', why: 'large', doneWhen: ['done'], children: ['Story 1', 'Story 2'] },
  stories: [story(1), story(2)],
});
const parsed = parseDecompositionOutput(decomposition);
if (!parsed.ok) throw new Error(parsed.reason);
const built = slicePlanFromDecomposition(45, parsed.decomposition);
if (!built.ok) throw new Error(built.reason);
const slicePlan = built.plan;
const temps = createTempDirs();
afterEach(() => temps.cleanup());

async function run(
  line: string,
  opts: { mode?: 'stack' | 'off'; park?: boolean; slice?: boolean; enforced?: boolean } = {},
) {
  const worktree = await temps.make('plan-escalation-');
  const store: SlicePlanStore = {
    find: async () => (opts.slice ? { status: 'found', plan: slicePlan, where: 'store' } : { status: 'not-found' }),
    save: async () => ({ where: 'store' }),
  };
  const stub = new StubModelExecutor({ scripts: { plan: [{ output: line }], decompose: [{ output: decomposition }] } });
  const result = await planPhase({
    issue: workKeyFromIssue(45),
    repo: 'owner/repo',
    worktree,
    specPath: join(worktree, 'spec.md'),
    router: new ModelRouter(models, routes, false, stub),
    constitution: null,
    octokit: {
      rest: { issues: { get: async () => ({ data: { title: 'Large issue', body } }) } },
    } as Octokit,
    log: () => {},
    sizeGateMode: opts.mode ?? 'stack',
    parkOverBudget: opts.park,
    enforceSizeGate: opts.enforced,
    slicePlanStore: store,
  });
  return { result, stub };
}

const split = 'ESCALATE: Please split this issue into smaller slices';
it('routes a planner split request to the slice gate in stack mode', async () => {
  const { result } = await run(split);
  expect(result.sliced?.sliceCount).toBe(2);
  expect(result.escalate).toContain('the next run plans slice 1');
});
it.each(['ESCALATE: missing-info: which provider?', 'ESCALATE: contradiction: conflicting scope'])(
  'parks %s in stack mode',
  async (line) => {
    expect((await run(line)).result.escalate).toBe(line);
  },
);
it('parks a slice that asks to split again', async () => {
  expect((await run(split, { slice: true })).result.escalate).toContain('a slice is never sliced again');
});
it.each([{ mode: 'off' as const }, { park: true }, { enforced: false }])(
  'parks a split request when slicing is disabled: %j',
  async (opts) => {
    expect((await run(split, opts)).result.escalate).toBe(split);
  },
);
