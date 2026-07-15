import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { ModelRouter } from './index.js';
import { StubModelExecutor } from './stub.js';

const models: ModelsConfig = {
  version: 1,
  models: {
    'stub-model': {
      provider: 'custom',
      tier: 'boss',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
    },
  },
  tiers: { boss: ['stub-model'] },
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
    plan: { tier: 'boss', description: 'stub' },
    build_claude: { tier: 'boss', description: 'stub' },
  },
};

const experimentalFirstModels: ModelsConfig = {
  version: 1,
  models: {
    'exp-model': {
      provider: 'custom',
      tier: 'boss',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
      experimental: true,
    },
    'real-model': {
      provider: 'custom',
      tier: 'boss',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
    },
  },
  tiers: { boss: ['exp-model', 'real-model'] },
  failover: {
    triggers: ['rate_limit', 'usage_cap', 'timeout', 'error', 'empty_response'],
    maxRetries: 2,
    cooldownMs: 0,
    escalateAfterTierExhausted: true,
  },
  routingRules: {},
};

const twoModels: ModelsConfig = {
  version: 1,
  models: {
    'model-a': {
      provider: 'custom',
      tier: 'boss',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
    },
    'model-b': {
      provider: 'custom',
      tier: 'boss',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
    },
  },
  tiers: { boss: ['model-a', 'model-b'] },
  failover: {
    triggers: ['rate_limit', 'usage_cap', 'timeout', 'error', 'empty_response'],
    maxRetries: 2,
    cooldownMs: 0,
    escalateAfterTierExhausted: true,
  },
  routingRules: {},
};

describe('ModelRouter with StubModelExecutor', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns canned responses without invoking a CLI', async () => {
    const stub = new StubModelExecutor({ scripts: { plan: [{ output: 'SCRIPTED PLAN' }] } });
    const router = new ModelRouter(models, routes, false, stub);

    const result = await router.run('plan', 'do it');

    expect(result.output).toBe('SCRIPTED PLAN');
    expect(result.model).toBe('stub-model');
    expect(result.attempts).toEqual([{ model: 'stub-model', reason: null, ok: true }]);
    expect(stub.calls).toHaveLength(1);
  });

  it('retries a simulated rate limit and then succeeds', async () => {
    const stub = new StubModelExecutor({
      scripts: { plan: [{ fail: 'rate_limit' }, { output: 'RECOVERED' }] },
    });
    const router = new ModelRouter(models, routes, false, stub);

    const result = await router.run('plan', 'do it');

    expect(result.output).toBe('RECOVERED');
    expect(result.attempts).toEqual([
      { model: 'stub-model', reason: 'rate_limit', ok: false, detail: 'msg="stub failure: rate_limit" exitCode=1' },
      { model: 'stub-model', reason: null, ok: true },
    ]);
    expect(stub.calls).toHaveLength(2);
  });

  it('throws when scripted failures exhaust retries', async () => {
    const stub = new StubModelExecutor({
      scripts: { plan: [{ fail: 'error' }, { fail: 'error' }] },
    });
    const router = new ModelRouter(models, routes, false, stub);

    const err: any = await router.run('plan', 'do it').catch(e => e);
    expect(err.message).toBe(
      "All models failed for task 'plan': stub-model(error: msg=\"stub failure: error\" exitCode=1), stub-model(error: msg=\"stub failure: error\" exitCode=1)",
    );
    expect(err.reason).toBe('error');
    expect(err.attempts).toEqual([
      { model: 'stub-model', reason: 'error', ok: false, detail: 'msg="stub failure: error" exitCode=1' },
      { model: 'stub-model', reason: 'error', ok: false, detail: 'msg="stub failure: error" exitCode=1' },
    ]);
    expect(stub.calls).toHaveLength(2);
  });

  it.each([
    ['429 too many', 1, 'rate_limit'],
    ['quota exceeded', 1, 'usage_cap'],
    ['anything', 124, 'timeout'],
    ['no content', 1, 'empty_response'],
    ['Error: boom', 1, 'error'],
    ['mysterious', 1, 'unknown'],
    ['rate limit hit', 1, 'rate_limit'],
    ['insufficient credit', 1, 'usage_cap'],
  ] as const)('classifies %j with exit code %i as %s', (stderr, exitCode, expected) => {
    const router = new ModelRouter(models, routes);

    expect(router.classifyFailure(stderr, exitCode)).toBe(expected);
  });

  it('retries rate limits then fails over to the next model', async () => {
    const stub = new StubModelExecutor({
      scripts: {
        plan: [
          { fail: 'rate_limit' },
          { fail: 'rate_limit' },
          { fail: 'rate_limit' },
          { output: 'RECOVERED' },
        ],
      },
    });
    const router = new ModelRouter(twoModels, routes, false, stub);

    const result = await router.run('plan', 'do it');

    expect(result.output).toBe('RECOVERED');
    expect(result.model).toBe('model-b');
    expect(stub.calls).toHaveLength(4);
    expect(result.attempts).toEqual([
      { model: 'model-a', reason: 'rate_limit', ok: false, detail: 'msg="stub failure: rate_limit" exitCode=1' },
      { model: 'model-a', reason: 'rate_limit', ok: false, detail: 'msg="stub failure: rate_limit" exitCode=1' },
      { model: 'model-a', reason: 'rate_limit', ok: false, detail: 'msg="stub failure: rate_limit" exitCode=1' },
      { model: 'model-b', reason: null, ok: true },
    ]);
  });

  it('awaits cooldown between rate-limit retries', async () => {
    vi.useFakeTimers();
    const cooldownMs = 1000;
    const modelsWithCooldown: ModelsConfig = {
      ...twoModels,
      failover: { ...twoModels.failover, cooldownMs },
    };
    const stub = new StubModelExecutor({
      scripts: {
        plan: [
          { fail: 'rate_limit' },
          { fail: 'rate_limit' },
          { fail: 'rate_limit' },
          { output: 'RECOVERED' },
        ],
      },
    });
    const router = new ModelRouter(modelsWithCooldown, routes, false, stub);
    let settled = false;

    const promise = router.run('plan', 'do it').then(result => {
      settled = true;
      return result;
    });

    // Flush every pending microtask without ever advancing the fake clock: if the
    // cooldown were not actually awaited, the retry loop would race through on
    // microtasks alone and this promise would already be settled.
    for (let i = 0; i < 100; i++) await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(cooldownMs * 2);
    const result = await promise;

    expect(result.output).toBe('RECOVERED');
    expect(result.model).toBe('model-b');
  });

  it('lists each model and reason when all models are exhausted', async () => {
    const stub = new StubModelExecutor({
      scripts: { plan: [{ fail: 'timeout' }, { fail: 'timeout' }] },
    });
    const router = new ModelRouter(twoModels, routes, false, stub);

    const err: any = await router.run('plan', 'do it').catch(e => e);
    expect(err.message).toBe(
      "All models failed for task 'plan': model-a(timeout: msg=\"stub failure: timeout\" exitCode=1), model-b(timeout: msg=\"stub failure: timeout\" exitCode=1)",
    );
    expect(err.reason).toBe('timeout');
    expect(err.attempts).toEqual([
      { model: 'model-a', reason: 'timeout', ok: false, detail: 'msg="stub failure: timeout" exitCode=1' },
      { model: 'model-b', reason: 'timeout', ok: false, detail: 'msg="stub failure: timeout" exitCode=1' },
    ]);
    expect(stub.calls).toHaveLength(2);
  });

  it("throws when a route's tier has no available models", async () => {
    const noModels: ModelsConfig = {
      ...models,
      tiers: { boss: [] },
    };
    const stub = new StubModelExecutor({ scripts: {} });
    const router = new ModelRouter(noModels, routes, false, stub);

    await expect(router.run('plan', 'do it')).rejects.toThrow(
      "No available models for task 'plan'",
    );
    expect(stub.calls).toHaveLength(0);
  });

  it('fails over immediately on usage cap without retrying the same model', async () => {
    const stub = new StubModelExecutor({
      scripts: { plan: [{ fail: 'usage_cap' }, { output: 'RECOVERED' }] },
    });
    const router = new ModelRouter(twoModels, routes, false, stub);

    const result = await router.run('plan', 'do it');

    expect(result.output).toBe('RECOVERED');
    expect(result.model).toBe('model-b');
    expect(stub.calls.map(call => call.model)).toEqual(['model-a', 'model-b']);
    expect(result.attempts).toEqual([
      { model: 'model-a', reason: 'usage_cap', ok: false, detail: 'msg="stub failure: usage_cap" exitCode=1' },
      { model: 'model-b', reason: null, ok: true },
    ]);
  });

  it('preserves detail when a bare error collapses to unknown (regression)', async () => {
    const calls: { model: string }[] = [];
    const executor = {
      async runModel(model: string) {
        calls.push({ model });
        throw new Error('spawn claude EAGAIN');
      },
    };
    const router = new ModelRouter(models, routes, false, executor);
    const logs: string[] = [];

    const err: any = await router.run('plan', 'do it', { onLog: msg => logs.push(msg) }).catch(e => e);

    expect(calls).toHaveLength(1);
    expect(err.attempts).toEqual([
      { model: 'stub-model', reason: 'unknown', ok: false, detail: 'msg="spawn claude EAGAIN"' },
    ]);
    expect(logs).toContain('stub-model failed (unknown) on plan');
    expect(logs).toContain('stub-model failure detail on plan: msg="spawn claude EAGAIN"');
    expect(err.message).toContain('unknown: msg="spawn claude EAGAIN"');
  });

  it('carries sanitized child-process fields in the failure detail', async () => {
    const executor = {
      async runModel() {
        throw Object.assign(new Error('Command failed: claude'), {
          code: 'EAGAIN',
          signal: 'SIGKILL',
          killed: true,
          stderr: `ANTHROPIC_API_KEY=sk-live-abc123 ${'x'.repeat(1000)}`,
        });
      },
    };
    const router = new ModelRouter(models, routes, false, executor);
    const logs: string[] = [];

    await router.run('plan', 'do it', { onLog: msg => logs.push(msg) }).catch(() => {});

    const detailLog = logs.find(msg => msg.includes('failure detail'));
    expect(detailLog).toContain('code=EAGAIN');
    expect(detailLog).toContain('signal=SIGKILL');
    expect(detailLog).toContain('killed=true');
    expect(detailLog).toContain('…');
    expect(detailLog).not.toContain('x'.repeat(1000));
    expect(detailLog).toContain('[redacted]');
    expect(detailLog).not.toContain('sk-live-abc123');
  });

  it('reclassifies empty output as empty_response without a duplicate attempt entry', async () => {
    const stub = new StubModelExecutor({ scripts: { plan: [{ output: '' }] } });
    const router = new ModelRouter(models, routes, false, stub);
    const logs: string[] = [];

    const err: any = await router.run('plan', 'do it', { onLog: msg => logs.push(msg) }).catch(e => e);

    expect(err.attempts).toEqual([
      { model: 'stub-model', reason: 'empty_response', ok: false, detail: 'msg="model returned empty output"' },
    ]);
    expect(logs).toContain('stub-model failed (empty_response) on plan');
    expect(err.message).toBe(
      "All models failed for task 'plan': stub-model(empty_response: msg=\"model returned empty output\")",
    );
  });

  it('skips experimental models by default', () => {
    const router = new ModelRouter(experimentalFirstModels, routes, false, new StubModelExecutor({ scripts: {} }), false);

    expect(router.resolve('plan')).toBe('real-model');
  });

  it('includes experimental models when allowExperimental is true', () => {
    const router = new ModelRouter(experimentalFirstModels, routes, false, new StubModelExecutor({ scripts: {} }), true);

    expect(router.resolve('plan')).toBe('exp-model');
  });

  it('filters resolved models to non-cloud Ollama models in local-only mode', () => {
    const mixedModels: ModelsConfig = {
      version: 1,
      models: {
        'codex-model': {
          provider: 'openai',
          tier: 'boss',
          costPerMtokInput: 0,
          costPerMtokOutput: 0,
          contextWindow: 1000,
          capabilities: [],
          envKey: null,
          codex: true,
        },
        'ollama-cloud': {
          provider: 'ollama',
          tier: 'boss',
          costPerMtokInput: 0,
          costPerMtokOutput: 0,
          contextWindow: 1000,
          capabilities: [],
          envKey: null,
          providerModel: 'glm-5.2:cloud',
        },
        'ollama-local': {
          provider: 'ollama',
          tier: 'boss',
          costPerMtokInput: 0,
          costPerMtokOutput: 0,
          contextWindow: 1000,
          capabilities: [],
          envKey: null,
          providerModel: 'qwen2.5-coder:14b',
        },
      },
      tiers: { boss: ['codex-model', 'ollama-cloud', 'ollama-local'] },
      failover: models.failover,
      routingRules: {},
    };
    const router = new ModelRouter(mixedModels, routes, false, new StubModelExecutor({ scripts: {} }), true, true);

    expect(router.resolveAll('plan')).toEqual(['ollama-local']);
  });

  it('excludes non-agentic harnesses from build_claude while keeping agentic ones', () => {
    const buildModels: ModelsConfig = {
      version: 1,
      models: {
        'agentic-model': {
          provider: 'anthropic',
          tier: 'boss',
          costPerMtokInput: 0,
          costPerMtokOutput: 0,
          contextWindow: 1000,
          capabilities: [],
          envKey: null,
        },
        'non-agentic-model': {
          provider: 'ollama',
          tier: 'boss',
          costPerMtokInput: 0,
          costPerMtokOutput: 0,
          contextWindow: 1000,
          capabilities: [],
          envKey: null,
        },
      },
      tiers: { boss: ['agentic-model', 'non-agentic-model'] },
      failover: models.failover,
      routingRules: {},
    };
    const router = new ModelRouter(buildModels, routes, false, new StubModelExecutor({ scripts: {} }));

    expect(router.resolveAll('build_claude')).toEqual(['agentic-model']);
  });
});

