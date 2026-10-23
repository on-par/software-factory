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
    'opencode-no-provider-model': {
      provider: 'custom',
      tier: 'boss',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
      harness: 'opencode',
    },
  },
  tiers: { boss: ['opencode-model', 'opencode-no-provider-model'] },
  failover: {
    triggers: ['rate_limit', 'unavailable', 'auth'],
    maxRetries: 2,
    cooldownMs: 0,
  },
  routingRules: {},
};

const registry = new ModelRegistry(modelsConfig);

const readFixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../__fixtures__/opencode/${name}`, import.meta.url)), 'utf8');
const jsonFixture = readFixture('run-json.jsonl');
const truncatedFixture = readFixture('truncated-no-final-step.jsonl');
const rateLimitFixture = readFixture('error-rate-limit.jsonl');

function recordingExec(result: { stdout?: string } = {}) {
  const calls: { cmd: string; stdin?: string }[] = [];
  const fn = async (cmd: string) => {
    if (cmd === 'opencode --version') return { stdout: '', stderr: '' };
    const promptPath = /< '([^']+)'$/.exec(cmd)?.[1];
    calls.push({ cmd, stdin: promptPath ? readFileSync(promptPath, 'utf8') : undefined });
    return { stdout: result.stdout ?? '', stderr: '' };
  };
  return { fn, calls };
}

describe('parseOpenCodeJson finished flag', () => {
  it('reports finished false when the last step_start has no step_finish', () => {
    expect(parseOpenCodeJson(truncatedFixture)?.finished).toBe(false);
  });

  it('reports finished true when every step_start is closed', () => {
    expect(parseOpenCodeJson(jsonFixture)?.finished).toBe(true);
  });

  it('reports finished true when no step_start was seen', () => {
    expect(parseOpenCodeJson('{"type":"text","part":{"text":"hi"}}')?.finished).toBe(true);
  });

  it('a step_finish without numeric tokens still closes the step', () => {
    const parsed = parseOpenCodeJson('{"type":"step_start"}\n{"type":"step_finish","part":{}}');
    expect(parsed?.finished).toBe(true);
    expect(parsed?.usage).toBeUndefined();
  });
});

describe('OpenCodeHarness truncated runs', () => {
  const run = (fn: any) =>
    new OpenCodeHarness(fn).run(makeContractRequest({ model: 'opencode-model', registry, prompt: 'build it' }));
  // Only the last step's text is returned (#2881).
  const FINAL = 'FINAL ANSWER: the build is done.';

  function sequenceExec(stdouts: string[]) {
    const calls: { cmd: string; stdin?: string }[] = [];
    const fn = async (cmd: string) => {
      if (cmd === 'opencode --version') return { stdout: '', stderr: '' };
      const promptPath = /< '([^']+)'$/.exec(cmd)?.[1];
      calls.push({ cmd, stdin: promptPath ? readFileSync(promptPath, 'utf8') : undefined });
      return { stdout: stdouts[calls.length - 1] ?? '', stderr: '' };
    };
    return { fn, calls };
  }

  it('retries once and throws empty_response naming step_finish when the last step never finishes', async () => {
    const rec = recordingExec({ stdout: truncatedFixture });
    const err: any = await run(rec.fn).catch((e) => e);
    expect(err).toBeInstanceOf(HarnessError);
    expect(err.reason).toBe('empty_response');
    expect(err.message).toContain('step_finish');
    expect(err.details.exitCode).toBe(0);
    expect(rec.calls).toHaveLength(2);
    expect(rec.calls[1].stdin).toContain('final message must contain');
  });

  it("returns the second attempt's text when the nudge retry completes the run", async () => {
    const seq = sequenceExec([truncatedFixture, jsonFixture]);
    const result = await run(seq.fn);
    expect(seq.calls).toHaveLength(2);
    expect(result.output).toBe(FINAL);
    expect(result.usage?.numTurns).toBe(2);
  });

  it('returns a complete run on the first attempt without retrying', async () => {
    const rec = recordingExec({ stdout: jsonFixture });
    const result = await run(rec.fn);
    expect(rec.calls).toHaveLength(1);
    expect(result.output).toBe(FINAL);
  });

  it('keeps the raw stdout fallback for non-JSON output', async () => {
    const rec = recordingExec({ stdout: 'OPENCODE OUTPUT' });
    const result = await run(rec.fn);
    expect(result.output).toBe('OPENCODE OUTPUT');
    expect(rec.calls).toHaveLength(1);
  });

  it('throws the classified error without retry when an error event leaves the step unfinished with text', async () => {
    const textLine = '{"type":"text","part":{"type":"text","text":"partial"}}';
    const rec = recordingExec({ stdout: `${rateLimitFixture}${textLine}\n` });
    const err: any = await run(rec.fn).catch((e) => e);
    expect(err).toBeInstanceOf(HarnessError);
    expect(err.reason).toBe('rate_limit');
    expect(rec.calls).toHaveLength(1);
  });
});
