import { describe, expect, it } from 'vitest';

import type { ModelsConfig } from '../config/index.js';
import { ModelRegistry } from '../models/index.js';
import { isEscalation } from '../utils/index.js';
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

const stepStart = '{"type":"step_start","part":{}}';
const stepFinish =
  '{"type":"step_finish","part":{"cost":0,"tokens":{"input":1,"output":1,"reasoning":0,"cache":{"read":0,"write":0}}}}';
const toolUse = '{"type":"tool_use","part":{"tool":"bash"}}';
const textEvent = (text: string) => JSON.stringify({ type: 'text', part: { text } });

function recordingExec(stdout: string) {
  const calls: { stdin?: string }[] = [];
  const fn = async (cmd: string) => {
    const promptPath = /< '([^']+)'$/.exec(cmd)?.[1];
    calls.push({ stdin: promptPath ? (await import('node:fs')).readFileSync(promptPath, 'utf8') : undefined });
    return { stdout, stderr: '' };
  };
  return { fn, calls };
}

const request = () => makeContractRequest({ model: 'opencode-model', registry, prompt: 'build it' });

describe('OpenCode final-step text (#2881)', () => {
  it('ignores an ESCALATE: line narrated in an earlier step', async () => {
    const stdout = [
      stepStart,
      textEvent('ESCALATE: need input'),
      stepFinish,
      stepStart,
      textEvent('done'),
      stepFinish,
    ].join('\n');
    const result = await new OpenCodeHarness(recordingExec(stdout).fn).run(request());
    expect(result.output).toBe('done');
    expect(isEscalation(result.output)).toBe(false);
  });

  it('nudge-retries and throws empty_response when only an earlier step has text', async () => {
    const stdout = [
      stepStart,
      textEvent("I'll inspect the repo first."),
      toolUse,
      stepFinish,
      stepStart,
      toolUse,
      stepFinish,
    ].join('\n');
    const rec = recordingExec(stdout);
    const err = await new OpenCodeHarness(rec.fn).run(request()).catch((e) => e);
    expect(rec.calls).toHaveLength(2);
    expect(rec.calls[1].stdin).toContain('your final message must contain your complete answer');
    expect(err).toBeInstanceOf(HarnessError);
    expect(err.reason).toBe('empty_response');
  });

  it('returns only the last step text parts joined by a blank line', () => {
    const stdout = [
      stepStart,
      textEvent('narration'),
      stepFinish,
      stepStart,
      textEvent('a'),
      textEvent('b'),
      stepFinish,
    ].join('\n');
    expect(parseOpenCodeJson(stdout)?.text).toBe('a\n\nb');
  });
});
