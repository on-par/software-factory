import { describe, expect, it, vi } from 'vitest';

import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { ClaudeCliHarness } from '../harness/claude-cli.js';
import type { HarnessLiveUsage } from '../harness/index.js';
import { BudgetStopError, isBudgetStopError, watchBudget } from './budget-guard.js';
import { CliModelExecutor, type ModelExecutor, ModelRouter } from './index.js';
import { ModelRegistry } from '../models/index.js';

const def = (provider: 'anthropic' | 'openai') => ({
  provider,
  tier: 'worker',
  costPerMtokInput: 3,
  costPerMtokOutput: 15,
  contextWindow: 1000,
  capabilities: [],
  envKey: null,
  claudeFlag: 'claude-sonnet-5',
});
const models: ModelsConfig = {
  version: 1,
  models: { 'model-a': def('anthropic'), 'model-b': def('openai') },
  tiers: { worker: ['model-a', 'model-b'] },
  failover: {
    triggers: ['rate_limit', 'usage_cap', 'timeout', 'error', 'empty_response'],
    maxRetries: 2,
    cooldownMs: 0,
    escalateAfterTierExhausted: true,
  },
  routingRules: {},
};
const routes: RoutesConfig = { version: 1, routes: { build_claude: { tier: 'worker', description: 'stub' } } };
const registry = new ModelRegistry(models);
const live = (over: Partial<HarnessLiveUsage> = {}): HarnessLiveUsage => ({
  inputTokens: 1_000_000,
  outputTokens: 0,
  calls: 7,
  ...over,
});

describe('watchBudget', () => {
  it('prices cumulative usage with the registry rates and records a stop only when the guard returns true', () => {
    const guard = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    const watch = watchBudget(registry, 'model-a', guard);
    watch.onLiveUsage(live({ calls: 1 }));
    expect(guard).toHaveBeenLastCalledWith(3, 1);
    expect(watch.stop).toBeUndefined();
    expect(() => watch.throwIfStopped()).not.toThrow();
    watch.onLiveUsage(live({ calls: 2, outputTokens: 1_000_000 }));
    expect(guard).toHaveBeenLastCalledWith(18, 2);
    expect(watch.stop).toMatchObject({ runningUsd: 18, calls: 2 });
    expect(() => watch.throwIfStopped()).toThrow(BudgetStopError);
  });

  it('ignores updates after a stop', () => {
    const guard = vi.fn().mockReturnValue(true);
    const watch = watchBudget(registry, 'model-a', guard);
    watch.onLiveUsage(live({ calls: 1 }));
    watch.onLiveUsage(live({ calls: 2 }));
    expect(guard).toHaveBeenCalledTimes(1);
    expect(watch.stop?.calls).toBe(1);
  });

  it('skips the guard for an unpriced model and for a non-finite cost', () => {
    const guard = vi.fn().mockReturnValue(true);
    watchBudget(registry, 'no-such-model', guard).onLiveUsage(live());
    watchBudget(registry, 'model-a', guard).onLiveUsage(live({ costUsd: Number.NaN }));
    expect(guard).not.toHaveBeenCalled();
  });

  it('uses costUsd when the harness supplies it', () => {
    const guard = vi.fn().mockReturnValue(false);
    watchBudget(registry, 'model-a', guard).onLiveUsage(live({ costUsd: 12.5 }));
    expect(guard).toHaveBeenCalledWith(12.5, 7);
  });

  it('recognises BudgetStopError by name as well as by class', () => {
    expect(isBudgetStopError(Object.assign(new Error('x'), { name: 'BudgetStopError' }))).toBe(true);
    expect(isBudgetStopError(new Error('x'))).toBe(false);
    expect(isBudgetStopError('x')).toBe(false);
  });
});

describe('ModelRouter budget guard', () => {
  const setup = (executor: ModelExecutor) => {
    const gitCalls: string[] = [];
    const git = vi.fn(async (cmd: string) => {
      gitCalls.push(cmd);
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    const router = new ModelRouter(models, routes, false, executor, false, false, git as never);
    const rows: Parameters<Parameters<ModelRouter['setCostSink']>[0]>[0][] = [];
    router.setCostSink((row) => rows.push(row));
    return { router, rows, gitCalls };
  };

  it('a budget-stopped attempt records a cost row for the partial session and throws BudgetStopError without retry, failover or worktree reset', async () => {
    const runModel = vi.fn(async (_m: string, _p: string, ctx: Parameters<ModelExecutor['runModel']>[2]) => {
      ctx.onLiveUsage?.(live({ inputTokens: 5000, outputTokens: 200, calls: 183 }));
      throw new Error('killed');
    });
    const { router, rows, gitCalls } = setup({ runModel });
    const onProviderFailure = vi.fn();
    const err = await router.run('build_claude', 'go', { budgetGuard: () => true, onProviderFailure }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(BudgetStopError);
    expect((err as BudgetStopError).stop.calls).toBe(183);
    expect(runModel).toHaveBeenCalledTimes(1);
    expect(onProviderFailure).not.toHaveBeenCalled();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ inputTokens: 5000, outputTokens: 200, estimated: false });
    expect(gitCalls.filter((c) => /git (reset|checkout|clean)/.test(c))).toEqual([]);
  });

  it('treats a successful return after the guard tripped as a budget stop', async () => {
    const { router, rows } = setup({
      runModel: async (_m, _p, ctx) => {
        ctx.onLiveUsage?.(live());
        return 'done';
      },
    });
    await expect(router.run('build_claude', 'go', { budgetGuard: () => true })).rejects.toBeInstanceOf(BudgetStopError);
    expect(rows).toHaveLength(1);
  });

  it('keeps ordinary failures on the retry and failover path when the guard never trips', async () => {
    const runModel = vi.fn(async () => {
      throw new Error('boom');
    });
    const { router } = setup({ runModel });
    const err = await router.run('build_claude', 'go', { budgetGuard: () => false }).catch((e: unknown) => e);
    expect(isBudgetStopError(err)).toBe(false);
    expect(runModel.mock.calls.length).toBeGreaterThan(1);
  });

  it('CliModelExecutor forwards ctx.onLiveUsage as HarnessRequest.onUsage', async () => {
    const run = vi.spyOn(ClaudeCliHarness.prototype, 'run').mockResolvedValue({ output: 'ok' });
    const onLiveUsage = vi.fn();
    await new CliModelExecutor().runModel('model-a', 'p', {
      worktree: '/tmp',
      timeoutSeconds: 1,
      task: 'plan',
      registry,
      routesConfig: routes,
      onLiveUsage,
    });
    expect(run.mock.calls[0][0].onUsage).toBe(onLiveUsage);
    run.mockRestore();
  });
});
