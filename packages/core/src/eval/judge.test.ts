import { describe, expect, it } from 'vitest';

import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { ModelRouter } from '../router/index.js';
import type { StubModelExecutorOptions } from '../router/stub.js';
import { StubModelExecutor } from '../router/stub.js';
import { extractVerdict, judgeSpec, median, runJudgeSamples, runJudgeSpec } from './judge.js';

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
  return routerForOutputs([output]);
}

function routerForOutputs(outputs: string[]): ModelRouter {
  return new ModelRouter(
    models,
    routes,
    false,
    new StubModelExecutor({ scripts: { eval_judge: outputs.map((output) => ({ output })) } }),
  );
}

function routerForSteps(steps: NonNullable<StubModelExecutorOptions['scripts']>['eval_judge']): ModelRouter {
  return new ModelRouter(models, routes, false, new StubModelExecutor({ scripts: { eval_judge: steps } }));
}

function judgeOpts() {
  return {
    specContent: 'spec',
    issueTitle: 'Issue',
    issueBody: 'Body',
    rubric: ['Score it'],
    worktree: process.cwd(),
    timeoutSeconds: 10,
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

describe('median', () => {
  it('returns the median for odd, even, and single-value inputs', () => {
    expect(median([8, 3, 7])).toBe(7);
    expect(median([7, 8])).toBe(7.5);
    expect(median([5])).toBe(5);
  });
});

describe('runJudgeSamples', () => {
  it('aggregates valid samples with the median score', async () => {
    const result = await runJudgeSamples(
      routerForOutputs(['{"score":8}', '{"score":3}', '{"score":7}']),
      judgeOpts(),
      3,
    );

    expect(result.score).toBe(7);
    expect(result.samples).toHaveLength(3);
    expect(result.validCount).toBe(3);
    expect(result.malformedCount).toBe(0);
  });

  it('excludes malformed samples from the median', async () => {
    const result = await runJudgeSamples(routerForOutputs(['{"score":8}', 'not json', '{"score":7}']), judgeOpts(), 3);

    expect(result.score).toBe(7.5);
    expect(result.validCount).toBe(2);
    expect(result.malformedCount).toBe(1);
    expect(result.samples[1]).toMatchObject({
      malformed: true,
      score: null,
    });
  });

  it('returns no score when all samples are malformed', async () => {
    const result = await runJudgeSamples(
      routerForOutputs(['not json', '{"reasons":"missing score"}', '{"score":true}']),
      judgeOpts(),
      3,
    );

    expect(result.score).toBeUndefined();
    expect(result.validCount).toBe(0);
    expect(result.malformedCount).toBe(3);
  });

  it('clamps k up to at least 1', async () => {
    const result = await runJudgeSamples(routerFor('{"score":5,"reasons":"ok"}'), judgeOpts(), 0);

    expect(result.samples).toHaveLength(1);
  });

  it('floors a fractional k', async () => {
    const result = await runJudgeSamples(routerForOutputs(['{"score":5}', '{"score":6}']), judgeOpts(), 2.9);

    expect(result.samples).toHaveLength(2);
  });

  it('omits a failed attempt from results while still recording its sample', async () => {
    const result = await runJudgeSamples(
      routerForSteps([{ fail: 'error' }, { output: '{"score":7,"reasons":"ok"}' }]),
      judgeOpts(),
      2,
    );

    expect(result.samples).toHaveLength(2);
    expect(result.results).toHaveLength(1);
  });
});

describe('judgeSpec', () => {
  it('returns only the score and reasons from the full run result', async () => {
    const result = await judgeSpec(routerFor('{"score":8,"reasons":"x"}'), judgeOpts());

    expect(result).toEqual({ score: 8, reasons: 'x' });
  });
});

describe('runJudgeSpec error handling', () => {
  it('returns a malformed sample with no result when the router run rejects', async () => {
    const result = await runJudgeSpec(routerForSteps([{ fail: 'error' }]), judgeOpts());

    expect(result.score).toBe(0);
    expect(result.malformed).toBe(true);
    expect(result.reasons).toMatch(/^judge failed:/);
    expect(result.result).toBeUndefined();
  });
});

describe('extractVerdict', () => {
  it('handles escaped quotes inside the reasons string', () => {
    const verdict = extractVerdict('{"score":5,"reasons":"say \\"hi\\""}');

    expect(verdict?.score).toBe(5);
    expect(verdict?.reasons).toContain('"hi"');
  });

  it('skips a malformed brace group and recovers the next balanced one', () => {
    const verdict = extractVerdict('{oops not json} {"score":6,"reasons":"ok"}');

    expect(verdict).toEqual({ score: 6, reasons: 'ok' });
  });
});
