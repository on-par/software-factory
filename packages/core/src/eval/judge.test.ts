import { describe, expect, it } from 'vitest';
import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { ModelRouter } from '../router/index.js';
import { StubModelExecutor } from '../router/stub.js';
import { runJudgeSpec } from './judge.js';

const models: ModelsConfig = {
  version: 1,
  models: {
    'stub-model': {
      provider: 'custom',
      tier: ['checker'],
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
    },
  },
  tiers: { checker: ['stub-model'] },
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
    eval_judge: { tier: 'checker', description: 'stub judge' },
  },
};

function routerFor(output: string): ModelRouter {
  return new ModelRouter(
    models,
    routes,
    false,
    new StubModelExecutor({ scripts: { eval_judge: [{ output }] } }),
  );
}

function judgeOpts() {
  return {
    specContent: 'spec',
    issueTitle: 'Issue',
    issueBody: 'Body',
    rubric: ['Score it'],
    worktree: process.cwd(),
    timeout: 10,
  };
}

describe('runJudgeSpec', () => {
  it('extracts a simple verdict', async () => {
    const result = await runJudgeSpec(routerFor('{"score": 8, "reasons": "solid"}'), judgeOpts());

    expect(result.score).toBe(8);
    expect(result.reasons).toBe('solid');
    expect(result.malformed).toBe(false);
  });

  it('extracts a verdict after preamble text with braces inside a string', async () => {
    const result = await runJudgeSpec(
      routerFor('preamble text {"score":7,"reasons":"has {braces} inside"}'),
      judgeOpts(),
    );

    expect(result.score).toBe(7);
    expect(result.reasons).toBe('has {braces} inside');
    expect(result.malformed).toBe(false);
  });

  it('clamps finite scores without marking them malformed', async () => {
    const high = await runJudgeSpec(routerFor('{"score": 15}'), judgeOpts());
    const low = await runJudgeSpec(routerFor('{"score": -3}'), judgeOpts());

    expect(high.score).toBe(10);
    expect(high.malformed).toBe(false);
    expect(low.score).toBe(0);
    expect(low.malformed).toBe(false);
  });

  it('marks non-json output malformed and preserves the full raw output', async () => {
    const output = `not json at all ${'x'.repeat(220)}`;
    const result = await runJudgeSpec(routerFor(output), judgeOpts());

    expect(result.malformed).toBe(true);
    expect(result.rawOutput).toBe(output);
  });

  it('marks json without a finite score malformed', async () => {
    const output = '{"reasons":"no score here"}';
    const result = await runJudgeSpec(routerFor(output), judgeOpts());

    expect(result.malformed).toBe(true);
    expect(result.rawOutput).toBe(output);
  });

  it('marks non-numeric score types malformed instead of coercing them', async () => {
    const bool = await runJudgeSpec(routerFor('{"score": true, "reasons": "looks good"}'), judgeOpts());
    const emptyString = await runJudgeSpec(routerFor('{"score": "", "reasons": "n/a"}'), judgeOpts());

    expect(bool.malformed).toBe(true);
    expect(emptyString.malformed).toBe(true);
  });
});
