import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { ModelRouter, ModelExecutorError, failoversFrom } from './index.js';
import type { ExecFn } from './index.js';
import { StubModelExecutor } from './stub.js';
import { HarnessError } from '../harness/index.js';

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
    expect(result.failoverReason).toBeUndefined();
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
    ['schema_invalid: proposal must be an object', 1, 'schema_invalid'],
    ['apply_failed: file could not be read', 1, 'apply_failed'],
    ['verification failed: exit 1', 1, 'verify_failed'],
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
    expect(result.failoverReason).toBe('usage_cap');
  });

  it.each(['usage_cap', 'timeout', 'empty_response'] as const)(
    'surfaces failoverReason %s on the winning result when the first model fails over to the second',
    async reason => {
      const stub = new StubModelExecutor({
        scripts: { plan: [{ fail: reason }, { output: 'RECOVERED' }] },
      });
      const router = new ModelRouter(twoModels, routes, false, stub);

      const result = await router.run('plan', 'do it');

      expect(result.model).toBe('model-b');
      expect(result.failoverReason).toBe(reason);
    },
  );

  it('surfaces failoverReason error once the single same-model retry is exhausted and it fails over', async () => {
    const stub = new StubModelExecutor({
      scripts: { plan: [{ fail: 'error' }, { fail: 'error' }, { output: 'RECOVERED' }] },
    });
    const router = new ModelRouter(twoModels, routes, false, stub);

    const result = await router.run('plan', 'do it');

    expect(result.model).toBe('model-b');
    expect(result.failoverReason).toBe('error');
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

  it('records exactly one empty_response attempt for empty output without throwing through the catch path', async () => {
    const stub = new StubModelExecutor({ scripts: { plan: [{ output: '' }] } });
    const router = new ModelRouter(models, routes, false, stub);
    const logs: string[] = [];

    const err: any = await router.run('plan', 'do it', { onLog: msg => logs.push(msg) }).catch(e => e);

    expect(err.attempts).toEqual([
      { model: 'stub-model', reason: 'empty_response', ok: false },
    ]);
    expect(logs).toContain('stub-model failed (empty_response) on plan');
    expect(err.message).toBe("All models failed for task 'plan': stub-model(empty_response)");
    expect(err.reason).toBe('empty_response');
  });

  it('treats whitespace-only output as empty_response without retrying the same model', async () => {
    const stub = new StubModelExecutor({ scripts: { plan: [{ output: '   \n\t ' }] } });
    const router = new ModelRouter(models, routes, false, stub);
    const logs: string[] = [];

    const err: any = await router.run('plan', 'do it', { onLog: msg => logs.push(msg) }).catch(e => e);

    expect(err.attempts).toEqual([
      { model: 'stub-model', reason: 'empty_response', ok: false },
    ]);
    expect(err.reason).toBe('empty_response');
    expect(stub.calls).toHaveLength(1);
  });

  it('fails over to the next model after an empty_response attempt', async () => {
    const stub = new StubModelExecutor({
      scripts: { plan: [{ output: '' }, { output: 'RECOVERED' }] },
    });
    const router = new ModelRouter(twoModels, routes, false, stub);

    const result = await router.run('plan', 'do it');

    expect(result.model).toBe('model-b');
    expect(result.output).toBe('RECOVERED');
    expect(result.attempts).toEqual([
      { model: 'model-a', reason: 'empty_response', ok: false },
      { model: 'model-b', reason: null, ok: true },
    ]);
  });

  it('fails over to the next model when the executor throws a typed empty_response', async () => {
    const stub = new StubModelExecutor({
      scripts: { plan: [{ fail: 'empty_response' }, { output: 'RECOVERED' }] },
    });
    const router = new ModelRouter(twoModels, routes, false, stub);

    const result = await router.run('plan', 'do it');

    expect(result.model).toBe('model-b');
    expect(result.output).toBe('RECOVERED');
    expect(result.attempts).toEqual([
      { model: 'model-a', reason: 'empty_response', ok: false, detail: 'msg="stub failure: empty_response" exitCode=1' },
      { model: 'model-b', reason: null, ok: true },
    ]);
  });

  it.each(['schema_invalid', 'apply_failed', 'verify_failed'] as const)(
    'stops the failover chain on a non-retryable %s reason without burning the next tier',
    async reason => {
      const stub = new StubModelExecutor({
        scripts: { plan: [{ fail: reason }, { output: 'SHOULD NOT BE REACHED' }] },
      });
      const router = new ModelRouter(twoModels, routes, false, stub);

      const err: any = await router.run('plan', 'do it').catch(e => e);

      expect(err.reason).toBe(reason);
      expect(err.attempts).toEqual([
        { model: 'model-a', reason, ok: false, detail: `msg="stub failure: ${reason}" exitCode=1` },
      ]);
      expect(stub.calls).toEqual([{ model: 'model-a', prompt: 'do it', task: 'plan' }]);
    },
  );

  it('logs the standard failure line and a non-retryable notice for a deterministic failure', async () => {
    const stub = new StubModelExecutor({
      scripts: { plan: [{ fail: 'schema_invalid' }] },
    });
    const router = new ModelRouter(twoModels, routes, false, stub);
    const logs: string[] = [];

    await router.run('plan', 'do it', { onLog: msg => logs.push(msg) }).catch(() => {});

    expect(logs).toContain('model-a failed (schema_invalid) on plan');
    expect(logs).toContain('model-a failed (schema_invalid) on plan — non-retryable, not failing over');
  });

  it('still retries a generic error once then fails over (non-retryable short-circuit does not change retryable behavior)', async () => {
    const stub = new StubModelExecutor({
      scripts: { plan: [{ fail: 'error' }, { fail: 'error' }, { output: 'RECOVERED' }] },
    });
    const router = new ModelRouter(twoModels, routes, false, stub);

    const result = await router.run('plan', 'do it');

    expect(result.output).toBe('RECOVERED');
    expect(result.model).toBe('model-b');
    expect(stub.calls).toHaveLength(3);
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

  it('reads the failover reason from a typed ModelExecutorError and fails over immediately', async () => {
    const calls: { model: string }[] = [];
    const executor = {
      async runModel(model: string) {
        calls.push({ model });
        throw new ModelExecutorError('cap', 'usage_cap', { exitCode: 1 });
      },
    };
    const router = new ModelRouter(models, routes, false, executor);

    const err: any = await router.run('plan', 'do it').catch(e => e);

    expect(err.attempts[0]).toMatchObject({ model: 'stub-model', reason: 'usage_cap', ok: false });
    expect(calls).toHaveLength(1);
  });

  it('reads the failover reason from a HarnessError and fails over without retrying', async () => {
    const calls: { model: string }[] = [];
    const executor = {
      async runModel(model: string) {
        calls.push({ model });
        throw new HarnessError('timed out', 'timeout');
      },
    };
    const router = new ModelRouter(models, routes, false, executor);

    const err: any = await router.run('plan', 'do it').catch(e => e);

    expect(err.attempts[0]).toMatchObject({ model: 'stub-model', reason: 'timeout', ok: false });
    expect(calls).toHaveLength(1);
  });

  it('ignores a bolted-on reason property on a plain Error and classifies from stderr/exit code instead', async () => {
    const executor = {
      async runModel() {
        throw Object.assign(new Error('boom'), { reason: 'usage_cap', stderr: 'quota exceeded', exitCode: 1 });
      },
    };
    const router = new ModelRouter(models, routes, false, executor);

    const err: any = await router.run('plan', 'do it').catch(e => e);

    expect(err.attempts[0]).toMatchObject({ reason: 'usage_cap' });
  });

  it('sets failoverReason on the RouterResult when a typed executor error on the first model fails over to the second', async () => {
    const zeroRetryModels: ModelsConfig = {
      ...twoModels,
      failover: { ...twoModels.failover, maxRetries: 0 },
    };
    let calls = 0;
    const executor = {
      async runModel(model: string) {
        calls++;
        if (model === 'model-a') throw new ModelExecutorError('cap', 'rate_limit', { exitCode: 1 });
        return 'RECOVERED';
      },
    };
    const router = new ModelRouter(zeroRetryModels, routes, false, executor);

    const result = await router.run('plan', 'do it');

    expect(result.model).toBe('model-b');
    expect(result.failoverReason).toBe('rate_limit');
    expect(calls).toBe(2);
  });

  it('records the tracePath detail from a ModelExecutorError', async () => {
    const executor = {
      async runModel() {
        throw new ModelExecutorError('failed', 'error', { tracePath: '/tmp/t.json' });
      },
    };
    const router = new ModelRouter(models, routes, false, executor);

    const err: any = await router.run('plan', 'do it').catch(e => e);

    expect(err.attempts[0].detail).toContain('trace=/tmp/t.json');
  });
});

describe('ModelRouter worktree reset guard', () => {
  const worktree = '/fake/worktree';

  function makeFakeGitExec(opts: {
    toplevel?: string | Error;
    postFailureStatus?: string;
    diffText?: string;
    resetError?: Error;
  } = {}): { execFn: ExecFn; calls: string[] } {
    const calls: string[] = [];
    let statusCallCount = 0;
    const execFn: ExecFn = async cmd => {
      calls.push(cmd);
      if (/git rev-parse --show-toplevel/.test(cmd)) {
        if (opts.toplevel instanceof Error) throw opts.toplevel;
        return { stdout: `${opts.toplevel ?? worktree}\n`, stderr: '' };
      }
      if (/git rev-parse HEAD/.test(cmd)) return { stdout: 'abc123\n', stderr: '' };
      if (/git status --porcelain/.test(cmd)) {
        statusCallCount++;
        const status = statusCallCount === 1 ? '' : (opts.postFailureStatus ?? ' M src/x.ts\n?? junk.txt\n');
        return { stdout: status, stderr: '' };
      }
      if (/git diff HEAD/.test(cmd)) return { stdout: opts.diffText ?? 'diff text\n', stderr: '' };
      if (/git reset --hard/.test(cmd)) {
        if (opts.resetError) throw opts.resetError;
        return { stdout: '', stderr: '' };
      }
      if (/git clean -fd/.test(cmd)) return { stdout: '', stderr: '' };
      throw new Error(`unhandled fake git command: ${cmd}`);
    };
    return { execFn, calls };
  }

  it('resets the worktree between a failed attempt and the failover attempt', async () => {
    const events: string[] = [];
    const { execFn, calls } = makeFakeGitExec();
    const stub = new StubModelExecutor({
      scripts: {
        build_claude: [
          { fail: 'timeout', effect: () => { events.push('call:model-a'); } },
          { output: 'OK', effect: () => { events.push('call:model-b'); } },
        ],
      },
    });
    const router = new ModelRouter(twoModels, routes, false, stub, undefined, undefined, execFn);

    const result = await router.run('build_claude', 'do it', { worktree });

    expect(result.model).toBe('model-b');
    expect(calls).toContain(`git reset --hard 'abc123'`);
    expect(calls.some(c => c.startsWith('git clean -fd'))).toBe(true);

    const resetIndex = events.indexOf('call:model-a');
    const failoverIndex = events.indexOf('call:model-b');
    const resetCallIndex = calls.findIndex(c => c.startsWith('git reset --hard'));
    const cleanCallIndex = calls.findIndex(c => c.startsWith('git clean -fd'));
    expect(resetIndex).toBeGreaterThanOrEqual(0);
    expect(failoverIndex).toBeGreaterThan(resetIndex);
    expect(resetCallIndex).toBeGreaterThanOrEqual(0);
    expect(cleanCallIndex).toBeGreaterThan(resetCallIndex);
  });

  it('issues zero git commands for non-agentic tasks', async () => {
    const { execFn, calls } = makeFakeGitExec();
    const stub = new StubModelExecutor({
      scripts: { plan: [{ fail: 'timeout' }, { output: 'OK' }] },
    });
    const router = new ModelRouter(twoModels, routes, false, stub, undefined, undefined, execFn);

    const result = await router.run('plan', 'do it', { worktree });

    expect(result.model).toBe('model-b');
    expect(calls).toHaveLength(0);
  });

  it('failover still works when the worktree guard is disabled', async () => {
    const { execFn, calls } = makeFakeGitExec({ toplevel: new Error('not a repo') });
    const stub = new StubModelExecutor({
      scripts: {
        build_claude: [{ fail: 'timeout' }, { output: 'OK' }],
      },
    });
    const router = new ModelRouter(twoModels, routes, false, stub, undefined, undefined, execFn);

    const result = await router.run('build_claude', 'do it', { worktree });

    expect(result.model).toBe('model-b');
    expect(calls.some(c => c.startsWith('git reset --hard'))).toBe(false);
  });

  it('aborts failover when the reset fails', async () => {
    const { execFn } = makeFakeGitExec({ resetError: new Error('reset exploded') });
    const stub = new StubModelExecutor({
      scripts: {
        build_claude: [{ fail: 'timeout' }, { output: 'OK' }],
      },
    });
    const router = new ModelRouter(twoModels, routes, false, stub, undefined, undefined, execFn);

    const err: any = await router.run('build_claude', 'do it', { worktree }).catch(e => e);

    expect(err.message).toMatch(/aborting failover to avoid mixing attempt state/);
    expect(stub.calls).toHaveLength(1);
  });

  it('skips the reset on a non-retryable failure', async () => {
    const { execFn, calls } = makeFakeGitExec();
    const stub = new StubModelExecutor({
      scripts: {
        build_claude: [{ fail: 'verify_failed' }, { output: 'SHOULD NOT BE REACHED' }],
      },
    });
    const router = new ModelRouter(twoModels, routes, false, stub, undefined, undefined, execFn);

    const err: any = await router.run('build_claude', 'do it', { worktree }).catch(e => e);

    expect(err.reason).toBe('verify_failed');
    expect(calls.some(c => c.startsWith('git reset --hard'))).toBe(false);
  });
});

describe('failoversFrom', () => {
  it('returns [] for a same-model rate_limit retry followed by a same-model success', () => {
    const attempts: Parameters<typeof failoversFrom>[0] = [
      { model: 'A', reason: 'rate_limit', ok: false },
      { model: 'A', reason: null, ok: true },
    ];

    expect(failoversFrom(attempts)).toEqual([]);
  });

  it('returns one entry when model A fails rate_limit and model B succeeds', () => {
    const attempts: Parameters<typeof failoversFrom>[0] = [
      { model: 'A', reason: 'rate_limit', ok: false, detail: 'boom' },
      { model: 'B', reason: null, ok: true },
    ];

    expect(failoversFrom(attempts)).toEqual([{ model: 'A', reason: 'rate_limit', detail: 'boom' }]);
  });

  it('returns one entry per model switch across mixed same-model retries and multi-hop failover', () => {
    const attempts: Parameters<typeof failoversFrom>[0] = [
      { model: 'A', reason: 'rate_limit', ok: false },
      { model: 'A', reason: 'rate_limit', ok: false, detail: 'still limited' },
      { model: 'B', reason: 'error', ok: false, detail: 'boom on B' },
      { model: 'C', reason: null, ok: true },
    ];

    expect(failoversFrom(attempts)).toEqual([
      { model: 'A', reason: 'rate_limit', detail: 'still limited' },
      { model: 'B', reason: 'error', detail: 'boom on B' },
    ]);
  });

  it('excludes the final failure with no following attempt (nothing to switch to)', () => {
    const attempts: Parameters<typeof failoversFrom>[0] = [
      { model: 'A', reason: 'error', ok: false, detail: 'boom' },
    ];

    expect(failoversFrom(attempts)).toEqual([]);
  });
});

