import { describe, expect, it } from 'vitest';
import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { ModelRouter } from '../router/index.js';
import { StubModelExecutor } from '../router/stub.js';
import type { GoldenCase } from './types.js';
import { runEval } from './runner.js';

const models: ModelsConfig = {
  version: 1,
  models: {
    'stub-model': {
      provider: 'custom',
      tier: ['boss', 'checker'],
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
    },
  },
  tiers: { boss: ['stub-model'], checker: ['stub-model'] },
  failover: {
    triggers: ['rate_limit', 'usage_cap', 'timeout', 'error', 'empty_response'],
    maxRetries: 0,
    cooldownMs: 0,
    escalateAfterTierExhausted: true,
  },
  routingRules: {},
};

const routes: RoutesConfig = {
  version: 1,
  routes: {
    plan: { tier: 'boss', description: 'stub' },
    eval_judge: { tier: 'checker', description: 'stub judge' },
  },
};

const goodSpec = `---
route: codex
---
# Spec
## Goal
Do it.
## Files / approach
Edit packages/core/src/eval/runner.ts.
## Tests
npm run test -w @on-par/factory-core
## Non-goals
No extras.
`;

const constitutionSpec = `---
route: codex
---
# Spec
## Goal
Do it.
## Files / approach
Edit packages/core/src/eval/runner.ts.
## Tests
npm run test -w @on-par/factory-core
## Constitution compliance
S1 is satisfied by labels. S2 is satisfied by a focused unit test.
## Non-goals
No extras.
`;

function goldenCase(overrides: Partial<GoldenCase> = {}): GoldenCase {
  return {
    id: 'case',
    title: 'Fix a bug',
    body: 'The issue body.',
    expectedRoute: 'codex',
    deterministicOnly: false,
    rubric: [],
    minRubricScore: 7,
    path: '/tmp/case.md',
    ...overrides,
  };
}

function tickingNow(step = 10) {
  let value = 0;
  return () => {
    const current = value;
    value += step;
    return current;
  };
}

describe('runEval', () => {
  it('summarizes passing and failing deterministic cases', async () => {
    const stub = new StubModelExecutor({
      scripts: { plan: [{ output: goodSpec }, { output: goodSpec.replace('route: codex', 'route: claude') }] },
    });
    const router = new ModelRouter(models, routes, false, stub);

    const summary = await runEval({
      cases: [goldenCase({ id: 'good' }), goldenCase({ id: 'bad' })],
      router,
      judge: false,
      now: tickingNow(),
    });

    expect(summary.passed).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.passRate).toBe(0.5);
    expect(summary.routeAsserted).toBe(2);
    expect(summary.routeAccuracy).toBe(0.5);
    expect(summary.results[0].expectedRoute).toBe('codex');
    expect(summary.totalLatencyMs).toBe(20);
  });

  it('skips the judge for deterministic-only cases', async () => {
    const stub = new StubModelExecutor({ scripts: { plan: [{ output: goodSpec }] } });
    const router = new ModelRouter(models, routes, false, stub);

    const summary = await runEval({
      cases: [goldenCase({ deterministicOnly: true, rubric: ['Score this'] })],
      router,
      judge: true,
      now: tickingNow(),
    });

    expect(summary.passed).toBe(1);
    expect(stub.calls.map(call => call.task)).toEqual(['plan']);
    expect(summary.results[0].judgeSkipped).toBe(true);
  });

  it('runs the judge and passes when the score meets the rubric threshold', async () => {
    const stub = new StubModelExecutor({
      scripts: {
        plan: [{ output: goodSpec }],
        eval_judge: [{ output: '{"score": 9, "reasons": "solid"}' }],
      },
    });
    const router = new ModelRouter(models, routes, false, stub);

    const summary = await runEval({
      cases: [goldenCase({ rubric: ['Names file'], minRubricScore: 8 })],
      router,
      judge: true,
      now: tickingNow(),
    });

    expect(summary.results[0].pass).toBe(true);
    expect(summary.results[0].rubricScore).toBe(9);
    expect(stub.calls.map(call => call.task)).toEqual(['plan', 'eval_judge']);
  });

  it('uses the median judge score when judgeK is greater than one', async () => {
    const stub = new StubModelExecutor({
      scripts: {
        plan: [{ output: goodSpec }],
        eval_judge: [
          { output: '{"score":8}' },
          { output: '{"score":3}' },
          { output: '{"score":7}' },
        ],
      },
    });
    const router = new ModelRouter(models, routes, false, stub);

    const summary = await runEval({
      cases: [goldenCase({ rubric: ['Names file'], minRubricScore: 7 })],
      router,
      judge: true,
      judgeK: 3,
      now: tickingNow(),
    });

    expect(summary.results[0].rubricScore).toBe(7);
    expect(summary.results[0].pass).toBe(true);
    expect(summary.results[0].judgeSamples).toHaveLength(3);
  });

  it('excludes malformed judge samples from the runner median', async () => {
    const stub = new StubModelExecutor({
      scripts: {
        plan: [{ output: goodSpec }],
        eval_judge: [
          { output: '{"score":8}' },
          { output: 'not json' },
          { output: '{"score":7}' },
        ],
      },
    });
    const router = new ModelRouter(models, routes, false, stub);

    const summary = await runEval({
      cases: [goldenCase({ rubric: ['Names file'], minRubricScore: 7 })],
      router,
      judge: true,
      judgeK: 3,
      now: tickingNow(),
    });

    expect(summary.results[0].rubricScore).toBe(7.5);
    expect(summary.results[0].judgeMalformed).toBeFalsy();
    expect(summary.results[0].judgeMalformedCount).toBe(1);
    expect(summary.results[0].judgeValidCount).toBe(2);
  });

  it('does not spend judge calls on deterministic-only or escalated cases', async () => {
    const stub = new StubModelExecutor({
      scripts: {
        plan: [
          { output: goodSpec },
          { output: 'ESCALATE: missing required context' },
        ],
        eval_judge: [
          { output: '{"score":8}' },
          { output: '{"score":7}' },
          { output: '{"score":6}' },
        ],
      },
    });
    const router = new ModelRouter(models, routes, false, stub);

    const summary = await runEval({
      cases: [
        goldenCase({ id: 'deterministic', deterministicOnly: true, rubric: ['Names file'] }),
        goldenCase({ id: 'escalated', expectedRoute: 'escalate', rubric: ['Names file'] }),
      ],
      router,
      judge: true,
      judgeK: 3,
      now: tickingNow(),
    });

    expect(stub.calls.map(call => call.task)).not.toContain('eval_judge');
    expect(summary.results[0].judgeSkipped).toBe(true);
    expect(summary.results[1].judgeSkipped).toBe(true);
  });

  it('fails loudly when the judge returns garbage', async () => {
    const stub = new StubModelExecutor({
      scripts: {
        plan: [{ output: goodSpec }],
        eval_judge: [{ output: 'not json' }],
      },
    });
    const router = new ModelRouter(models, routes, false, stub);

    const summary = await runEval({
      cases: [goldenCase({ rubric: ['Names file'] })],
      router,
      judge: true,
      now: tickingNow(),
    });

    expect(summary.results[0].pass).toBe(false);
    expect(summary.results[0].judgeMalformed).toBe(true);
    expect(summary.results[0].rubricScore).toBeUndefined();
    expect(summary.results[0].error).toContain('not json');
  });

  it('parses nested-brace judge verdicts', async () => {
    const stub = new StubModelExecutor({
      scripts: {
        plan: [{ output: goodSpec }],
        eval_judge: [{ output: '{"score":9,"reasons":"has {nested} braces"}' }],
      },
    });
    const router = new ModelRouter(models, routes, false, stub);

    const summary = await runEval({
      cases: [goldenCase({ rubric: ['Names file'], minRubricScore: 8 })],
      router,
      judge: true,
      now: tickingNow(),
    });

    expect(summary.results[0].rubricScore).toBe(9);
    expect(summary.results[0].pass).toBe(true);
    expect(summary.results[0].judgeMalformed).toBeFalsy();
  });

  it('records router errors and continues the run', async () => {
    const stub = new StubModelExecutor({
      scripts: { plan: [{ fail: 'error' }, { output: goodSpec }] },
    });
    const router = new ModelRouter(models, routes, false, stub);

    const summary = await runEval({
      cases: [goldenCase({ id: 'throws' }), goldenCase({ id: 'continues' })],
      router,
      judge: false,
      now: tickingNow(),
    });

    expect(summary.results[0].pass).toBe(false);
    expect(summary.results[0].error).toContain("All models failed for task 'plan'");
    expect(summary.results[1].pass).toBe(true);
  });

  it('reports zero estimated cost for zero-cost stub models', async () => {
    const stub = new StubModelExecutor({ scripts: { plan: [{ output: goodSpec }] } });
    const router = new ModelRouter(models, routes, false, stub);

    const summary = await runEval({
      cases: [goldenCase()],
      router,
      judge: false,
      now: tickingNow(),
    });

    expect(summary.results[0].latencyMs).toBe(10);
    expect(summary.results[0].costEstimate).toBe(0);
    expect(summary.totalCostEstimate).toBe(0);
  });

  it('requires constitution compliance for cases with an inline constitution', async () => {
    const stub = new StubModelExecutor({
      scripts: { plan: [{ output: constitutionSpec }, { output: goodSpec }] },
    });
    const router = new ModelRouter(models, routes, false, stub);

    const summary = await runEval({
      cases: [
        goldenCase({ id: 'with-constitution', constitution: '<constitution>S1</constitution>' }),
        goldenCase({ id: 'missing-constitution', constitution: '<constitution>S1</constitution>' }),
      ],
      router,
      judge: false,
      now: tickingNow(),
    });

    expect(summary.results[0].pass).toBe(true);
    expect(summary.results[1].pass).toBe(false);
    expect(summary.results[1].checks.find(check => check.name === 'sections-present')?.details)
      .toContain('## Constitution compliance');
  });
});
