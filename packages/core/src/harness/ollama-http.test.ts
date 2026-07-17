import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ModelsConfig } from '../config/index.js';
import { ModelRegistry } from '../models/index.js';
import { codingHarnessContractCases, makeContractRequest } from './contract.js';
import { HarnessError } from './index.js';
import type { OllamaFetchFn } from './ollama-http.js';
import { OllamaHttpHarness } from './ollama-http.js';

function okFetch(json: unknown): OllamaFetchFn {
  return async () => ({ ok: true, status: 200, statusText: 'OK', text: async () => '', json: async () => json });
}

describe('CodingHarness contract: OllamaHttpHarness', () => {
  const cases = codingHarnessContractCases({
    success: () => ({ harness: new OllamaHttpHarness(okFetch({ message: { content: 'ollama output' } })) }),
    timeout: () => ({
      harness: new OllamaHttpHarness(async () => {
        throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
      }),
    }),
    emptyOutput: () => ({ harness: new OllamaHttpHarness(okFetch({ message: { content: '   ' } })) }),
    failure: () => ({
      harness: new OllamaHttpHarness(async () => ({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        text: async () => 'rate limit exceeded',
        json: async () => ({}),
      })),
    }),
  });
  for (const contractCase of cases) it(contractCase.name, contractCase.run);
});

describe('OllamaHttpHarness capability declaration', () => {
  it('is not agentic and reports a stable id', () => {
    const harness = new OllamaHttpHarness(okFetch({ message: { content: 'ollama output' } }));
    expect(harness.agentic).toBe(false);
    expect(harness.id).toBe('ollama-http');
  });
});

const modelsConfig: ModelsConfig = {
  version: 1,
  models: {
    'ollama-model': {
      provider: 'ollama',
      tier: 'boss',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
      providerModel: 'qwen2.5-coder:14b',
      providerOptions: { num_ctx: 16384, temperature: 0.2 },
    },
    'ollama-plain': {
      provider: 'ollama',
      tier: 'boss',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
    },
  },
  tiers: { boss: ['ollama-model', 'ollama-plain'] },
  failover: {
    triggers: ['rate_limit', 'usage_cap', 'timeout', 'error', 'empty_response'],
    maxRetries: 2,
    cooldownMs: 0,
    escalateAfterTierExhausted: true,
  },
  routingRules: {},
};

const registry = new ModelRegistry(modelsConfig);

function recordingFetch(result: { json?: unknown } = {}) {
  const calls: { input: string; init: any }[] = [];
  const fn: OllamaFetchFn = async (input, init) => {
    calls.push({ input, init });
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => '',
      json: async () => result.json ?? { message: { content: 'OLLAMA OUTPUT' } },
    };
  };
  return { fn, calls };
}

describe('OllamaHttpHarness request shape', () => {
  it('builds the expected POST request with provider options', async () => {
    const rec = recordingFetch();
    const harness = new OllamaHttpHarness(rec.fn);

    const result = await harness.run(
      makeContractRequest({
        model: 'ollama-model',
        registry,
        prompt: 'draft plan',
      }),
    );

    expect(result.output).toBe('OLLAMA OUTPUT');
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0].input).toBe('http://127.0.0.1:11434/api/chat');
    expect(rec.calls[0].init.method).toBe('POST');
    expect(rec.calls[0].init.headers['content-type']).toBe('application/json');
    expect(rec.calls[0].init.signal).toBeDefined();
    expect(JSON.parse(rec.calls[0].init.body)).toEqual({
      model: 'qwen2.5-coder:14b',
      stream: false,
      messages: [{ role: 'user', content: 'draft plan' }],
      options: { num_ctx: 16384, temperature: 0.2 },
    });
  });

  it('omits options when none are configured', async () => {
    const rec = recordingFetch();
    const harness = new OllamaHttpHarness(rec.fn);

    await harness.run(makeContractRequest({ model: 'ollama-plain', registry }));

    expect(rec.calls).toHaveLength(1);
    const body = JSON.parse(rec.calls[0].init.body);
    expect(body).not.toHaveProperty('options');
  });
});

describe('OllamaHttpHarness base URL override', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('strips a trailing slash from OLLAMA_BASE_URL', async () => {
    vi.stubEnv('OLLAMA_BASE_URL', 'http://gpu-box:11434/');
    const rec = recordingFetch();
    const harness = new OllamaHttpHarness(rec.fn);

    await harness.run(makeContractRequest({ model: 'ollama-model', registry }));

    expect(rec.calls[0].input).toBe('http://gpu-box:11434/api/chat');
  });
});

describe('OllamaHttpHarness failure classification', () => {
  it('classifies a non-ok HTTP response', async () => {
    const harness = new OllamaHttpHarness(async () => ({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: async () => 'boom',
      json: async () => ({}),
    }));

    const err: any = await harness.run(makeContractRequest({ model: 'ollama-model', registry })).catch((e) => e);

    expect(err).toBeInstanceOf(HarnessError);
    expect(err.details.exitCode).toBe(500);
    expect(err.details.stderr).toBe('boom');
    expect(err.message).toContain('ollama 500');
  });

  it('classifies a JSON error payload as usage_cap', async () => {
    const harness = new OllamaHttpHarness(okFetch({ error: 'quota exceeded' }));

    const err: any = await harness.run(makeContractRequest({ model: 'ollama-model', registry })).catch((e) => e);

    expect(err).toBeInstanceOf(HarnessError);
    expect(err.reason).toBe('usage_cap');
    expect(err.details.stderr).toBe('quota exceeded');
  });

  it('classifies empty message content as empty_response', async () => {
    const harness = new OllamaHttpHarness(okFetch({ message: { content: '' } }));

    const err: any = await harness.run(makeContractRequest({ model: 'ollama-model', registry })).catch((e) => e);

    expect(err).toBeInstanceOf(HarnessError);
    expect(err.reason).toBe('empty_response');
    expect(err.details.exitCode).toBe(0);
  });

  it('falls back to the generate-style response field', async () => {
    const harness = new OllamaHttpHarness(okFetch({ response: 'GEN OUTPUT' }));

    const result = await harness.run(makeContractRequest({ model: 'ollama-model', registry }));

    expect(result.output).toBe('GEN OUTPUT');
  });

  it('preserves a pre-set reason from a thrown transport error', async () => {
    const harness = new OllamaHttpHarness(async () => {
      throw Object.assign(new Error('socket closed'), { reason: 'error' });
    });

    const err: any = await harness.run(makeContractRequest({ model: 'ollama-model', registry })).catch((e) => e);

    expect(err).toBeInstanceOf(HarnessError);
    expect(err.reason).toBe('error');
  });
});
