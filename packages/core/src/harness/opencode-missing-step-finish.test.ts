import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { ModelsConfig } from '../config/index.js';
import { ModelRegistry } from '../models/index.js';
import { makeContractRequest } from './contract.js';
import { HarnessError } from './index.js';
import { OpenCodeHarness, parseOpenCodeJson } from './opencode.js';

const modelsConfig: ModelsConfig = {
  version: 1,
  models: {
    'opencode-model': {
      provider: 'custom',
      tier: 'boss',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
      harness: 'opencode',
      providerModel: 'anthropic/claude-sonnet-5',
    },
  },
  tiers: { boss: ['opencode-model'] },
  failover: {
    triggers: ['rate_limit', 'usage_cap', 'timeout', 'error', 'empty_response'],
    maxRetries: 2,
    cooldownMs: 0,
    escalateAfterTierExhausted: true,
  },
  routingRules: {},
};

const registry = new ModelRegistry(modelsConfig);

const readFixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../__fixtures__/opencode/${name}`, import.meta.url)), 'utf8');
const jsonFixture = readFixture('run-json.jsonl');
const emptyFinalStepFixture = readFixture('truncated-empty-final-step.jsonl');

// Returns each stdout in turn and records the prompt file each call received.
function sequenceExec(stdouts: string[]) {
  const calls: { cmd: string; stdin?: string }[] = [];
  const fn = async (cmd: string) => {
    if (cmd === 'opencode --version') return { stdout: '', stderr: '' };
    const promptPath = /< '([^']+)'$/.exec(cmd)?.[1];
    calls.push({ cmd, stdin: promptPath ? readFileSync(promptPath, 'utf8') : undefined });
    return { stdout: stdouts[Math.min(calls.length, stdouts.length) - 1] ?? '', stderr: '' };
  };
  return { fn, calls };
}

describe('OpenCodeHarness missing final step_finish (#3024)', () => {
  const run = (fn: any) =>
    new OpenCodeHarness(fn).run(makeContractRequest({ model: 'opencode-model', registry, prompt: 'build it' }));

  it('parseOpenCodeJson reports finished false and empty text when the final step has no step_finish', () => {
    const parsed = parseOpenCodeJson(emptyFinalStepFixture);
    expect(parsed?.finished).toBe(false);
    expect(parsed?.text).toBe('');
    expect(parsed?.usage?.numTurns).toBe(1);
  });

  it('retries once with the nudge, then throws a retryable empty_response naming step_finish', async () => {
    const rec = sequenceExec([emptyFinalStepFixture]);
    const err: any = await run(rec.fn).catch((e) => e);
    expect(err).toBeInstanceOf(HarnessError);
    expect(err.reason).toBe('empty_response');
    expect(err.message).toContain('step_finish');
    expect(err.details.exitCode).toBe(0);
    expect(rec.calls).toHaveLength(2);
    expect(rec.calls[1].stdin).toContain('final message must contain');
    expect(rec.calls[0].stdin).not.toContain('final message must contain');
  });

  it("returns the retry's final text when the second attempt completes", async () => {
    const seq = sequenceExec([emptyFinalStepFixture, jsonFixture]);
    const result = await run(seq.fn);
    expect(seq.calls).toHaveLength(2);
    expect(result.output).toBe('FINAL ANSWER: the build is done.');
  });

  it('does not return earlier narration as success when the final step never finishes', async () => {
    const rec = sequenceExec([emptyFinalStepFixture]);
    const outcome: any = await run(rec.fn).then(
      (r) => r,
      (e) => e,
    );
    expect(outcome).toBeInstanceOf(HarnessError);
    expect(outcome.output).toBeUndefined();
  });
});
