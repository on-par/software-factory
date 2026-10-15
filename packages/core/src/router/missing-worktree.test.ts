import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { HarnessError } from '../harness/index.js';
import { ModelRouter, ModelRouterError } from './index.js';

const model = (provider: 'anthropic' | 'openai') => ({
  provider,
  tier: 'boss',
  costPerMtokInput: 0,
  costPerMtokOutput: 0,
  contextWindow: 1000,
  capabilities: [],
  envKey: null,
});

const twoModels: ModelsConfig = {
  version: 1,
  models: { 'model-a': model('anthropic'), 'model-b': model('openai') },
  tiers: { boss: ['model-a', 'model-b'] },
  failover: {
    triggers: ['rate_limit', 'usage_cap', 'timeout', 'error', 'empty_response'],
    maxRetries: 2,
    cooldownMs: 0,
    escalateAfterTierExhausted: true,
  },
  routingRules: {},
};

const routes: RoutesConfig = { version: 1, routes: { plan: { tier: 'boss', description: 'stub' } } };

describe('ModelRouter missing worktree (#2964)', () => {
  it('names the missing worktree instead of failing over when the cwd was deleted (#2964)', async () => {
    const gone = join(tmpdir(), `gone-${Math.random().toString(36).slice(2)}`);
    const runModel = vi.fn(async () => {
      throw new HarnessError('claude CLI process exited ENOENT', 'cli_missing', { code: 'ENOENT' });
    });
    const router = new ModelRouter(twoModels, routes, false, { runModel });

    const err: any = await router.run('plan', 'do it', { worktree: gone }).catch((e) => e);

    expect(err).toBeInstanceOf(ModelRouterError);
    expect(err.message).toContain('Worktree missing');
    expect(err.message).toContain(gone);
    expect(runModel).toHaveBeenCalledTimes(1);
  });

  it('still fails over when the worktree exists and the attempt fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'router-wt-'));
    try {
      const runModel = vi.fn(async (m: string) => {
        if (m === 'model-a') throw new HarnessError('claude CLI process exited ENOENT', 'cli_missing');
        return 'OK';
      });
      const router = new ModelRouter(twoModels, routes, false, { runModel });

      const result = await router.run('plan', 'do it', { worktree: dir });

      expect(result.model).toBe('model-b');
      expect(runModel).toHaveBeenCalledTimes(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
