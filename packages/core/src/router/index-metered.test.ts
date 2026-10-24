import { describe, expect, it, vi } from 'vitest';

import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { ModelRouter } from './index.js';
import { StubModelExecutor } from './stub.js';

const models: ModelsConfig = {
  version: 1,
  models: {},
  tiers: { boss: [] },
  failover: { triggers: ['rate_limit', 'unavailable', 'auth'], maxRetries: 2, cooldownMs: 0 },
  routingRules: {},
};

const routes: RoutesConfig = {
  version: 1,
  routes: { plan: { tier: 'boss', description: 'stub' } },
};

describe('metered failover guard (#3234)', () => {
  const base = { tier: 'boss', costPerMtokInput: 0, costPerMtokOutput: 0, contextWindow: 1000, capabilities: [] };
  const meteredModels: ModelsConfig = {
    ...models,
    models: {
      'claude-m': { ...base, provider: 'anthropic' as const, envKey: null, harness: 'claude-cli' },
      'gpt-m': { ...base, provider: 'openai' as const, envKey: null, harness: 'codex-cli' },
    },
    tiers: { boss: ['claude-m', 'gpt-m'] },
  };
  const noFile = () => {
    throw new Error('ENOENT');
  };
  const claudeSub = {
    platform: 'linux' as const,
    fileExists: () => false,
    homedir: () => '/h',
  };
  const codexApi = { ...claudeSub, env: { CLAUDE_CODE_OAUTH_TOKEN: 't', OPENAI_API_KEY: 'k' }, readFile: noFile };
  const codexSub = {
    ...claudeSub,
    env: { CLAUDE_CODE_OAUTH_TOKEN: 't' },
    readFile: () => JSON.stringify({ tokens: { refresh_token: 'r' } }),
    exec: vi.fn(),
  };
  const codexUnknown = {
    ...claudeSub,
    env: { CLAUDE_CODE_OAUTH_TOKEN: 't' },
    readFile: noFile,
    exec: () => {
      throw new Error('not logged in');
    },
  };
  const heldClaude = async (p: string) => p === 'anthropic';

  it('automatic failover never moves onto a metered provider', async () => {
    const stub = new StubModelExecutor({ scripts: { plan: [{ fail: 'unavailable' }, { output: 'FROM GPT' }] } });
    const router = new ModelRouter(meteredModels, routes, false, stub);
    router.setProviderPlanDeps(codexApi);

    await expect(router.run('plan', 'do it')).rejects.toMatchObject({ detail: 'only_metered_left' });
    expect(stub.calls.map((c) => c.model)).toEqual(['claude-m']);
  });

  it('a held (capped) claude model never fails over onto an API-key Codex', async () => {
    const stub = new StubModelExecutor({ scripts: { plan: [{ output: 'FROM GPT' }] } });
    const router = new ModelRouter(meteredModels, routes, false, stub);
    router.setProviderHold(heldClaude);
    router.setProviderPlanDeps(codexApi);
    const logs: string[] = [];

    await expect(router.run('plan', 'do it', { onLog: (l) => logs.push(l) })).rejects.toMatchObject({
      detail: 'only_metered_left',
      reason: 'unavailable',
    });
    expect(stub.calls).toHaveLength(0);
    const skips = logs.filter((l) => l.startsWith('provider_failover_metered_skip:'));
    expect(skips).toHaveLength(1);
    expect(skips[0]).toContain('gpt-m');
    expect(skips[0]).toContain('provider=openai');
    expect(skips[0]).toContain('plan=api');
    expect(logs.join('\n')).not.toContain("'k'");
  });

  it('fails over to a Codex on a ChatGPT login (subscription)', async () => {
    const stub = new StubModelExecutor({ scripts: { plan: [{ output: 'FROM GPT' }] } });
    const router = new ModelRouter(meteredModels, routes, false, stub);
    router.setProviderHold(heldClaude);
    router.setProviderPlanDeps(codexSub);
    const logs: string[] = [];

    const result = await router.run('plan', 'do it', { onLog: (l) => logs.push(l) });
    expect(result.model).toBe('gpt-m');
    expect(logs.some((l) => l.startsWith('provider_failover_metered_skip:'))).toBe(false);
  });

  it('an unknown-plan failover target is skipped like api', async () => {
    const stub = new StubModelExecutor({ scripts: { plan: [{ output: 'FROM GPT' }] } });
    const router = new ModelRouter(meteredModels, routes, false, stub);
    router.setProviderHold(heldClaude);
    router.setProviderPlanDeps(codexUnknown);

    await expect(router.run('plan', 'do it')).rejects.toMatchObject({ detail: 'only_metered_left' });
    expect(stub.calls).toHaveLength(0);
  });

  it('an explicit metered pin primary runs with no skip', async () => {
    const stub = new StubModelExecutor({ scripts: { plan: [{ output: 'FROM GPT' }] } });
    const router = new ModelRouter(meteredModels, routes, false, stub);
    router.setProviderPlanDeps(codexApi);
    const logs: string[] = [];

    const result = await router.run('plan', 'do it', { modelOverride: 'gpt-m', onLog: (l) => logs.push(l) });
    expect(result.model).toBe('gpt-m');
    expect(logs.some((l) => l.startsWith('provider_failover_metered_skip:'))).toBe(false);
  });

  it("a retryCause 'failover' override (auto_failover.fallback_model) is guarded", async () => {
    const stub = new StubModelExecutor({ scripts: { plan: [{ output: 'FROM GPT' }] } });
    const router = new ModelRouter(meteredModels, routes, false, stub);
    router.setProviderPlanDeps(codexApi);

    await expect(router.run('plan', 'do it', { modelOverride: 'gpt-m', retryCause: 'failover' })).rejects.toMatchObject(
      { detail: 'only_metered_left' },
    );
    expect(stub.calls).toHaveLength(0);
  });

  it('without setProviderPlanDeps routing is unchanged', async () => {
    const stub = new StubModelExecutor({ scripts: { plan: [{ output: 'FROM GPT' }] } });
    const router = new ModelRouter(meteredModels, routes, false, stub);
    router.setProviderHold(heldClaude);

    const result = await router.run('plan', 'do it');
    expect(result.model).toBe('gpt-m');
  });

  it('the plan is detected once per model per router', async () => {
    const readFile = vi.fn(noFile);
    const stub = new StubModelExecutor({ scripts: { plan: [] } });
    const router = new ModelRouter(meteredModels, routes, false, stub);
    router.setProviderHold(heldClaude);
    router.setProviderPlanDeps({
      ...codexApi,
      env: { CLAUDE_CODE_OAUTH_TOKEN: 't' },
      readFile,
      exec: () => {
        throw new Error('x');
      },
    });

    await expect(router.run('plan', 'do it')).rejects.toMatchObject({ detail: 'only_metered_left' });
    const afterFirst = readFile.mock.calls.length;
    await expect(router.run('plan', 'do it')).rejects.toMatchObject({ detail: 'only_metered_left' });
    expect(afterFirst).toBeGreaterThan(0);
    expect(readFile.mock.calls.length).toBe(afterFirst);
  });
});
