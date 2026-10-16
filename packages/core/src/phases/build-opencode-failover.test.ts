import { describe, expect, it } from 'vitest';

import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { ModelRouter } from '../router/index.js';
import { ModelRouterError } from '../router/executor-error.js';
import { opencodeCapError, opencodeCapResetAt, pickOpencodeFallback } from './build-opencode-failover.js';

const ROUTES: RoutesConfig = {
  version: 1,
  routes: {
    build_claude: { tier: 'worker', description: 'stub', requires: 'claude' },
    build_codex: { tier: 'worker', description: 'stub', requires: 'codex' },
  },
};

function routerWith(defs: Record<string, { provider: string; codex?: boolean }>): ModelRouter {
  const models: ModelsConfig = {
    version: 1,
    models: Object.fromEntries(
      Object.entries(defs).map(([id, def]) => [
        id,
        {
          provider: def.provider as ModelsConfig['models'][string]['provider'],
          tier: 'worker',
          costPerMtokInput: 0,
          costPerMtokOutput: 0,
          contextWindow: 1000,
          capabilities: [],
          envKey: null,
          ...(def.codex ? { codex: true } : {}),
        },
      ]),
    ),
    tiers: { worker: Object.keys(defs) },
    failover: { triggers: [], maxRetries: 0, cooldownMs: 0, escalateAfterTierExhausted: false },
    routingRules: {},
  };
  return new ModelRouter(models, ROUTES);
}

describe('pickOpencodeFallback (#2891)', () => {
  const claude = { provider: 'anthropic' };
  const codex = { provider: 'openai', codex: true };

  it('prefers the first build_claude worker', () => {
    expect(pickOpencodeFallback(routerWith({ 'claude-a': claude, 'gpt-a': codex }))).toEqual({
      route: 'claude',
      task: 'build_claude',
      model: 'claude-a',
    });
  });

  it('falls back to the first build_codex worker when there is no claude worker', () => {
    expect(pickOpencodeFallback(routerWith({ 'gpt-a': codex }))).toEqual({
      route: 'codex',
      task: 'build_codex',
      model: 'gpt-a',
    });
  });

  it('returns undefined when codex is disabled and there is no claude worker', () => {
    expect(pickOpencodeFallback(routerWith({ 'gpt-a': codex }), true)).toBeUndefined();
  });
});

describe('opencodeCapResetAt (#3034)', () => {
  const now = Date.parse('2026-10-15T00:00:00Z');
  const attempt = (detail?: string) => ({ model: 'oc-a', ok: false, reason: 'usage_cap' as const, detail });

  it('returns the absolute reset instant', () => {
    expect(opencodeCapResetAt([attempt('resets at 2026-11-01T00:00:00Z')], now)).toBe('2026-11-01T00:00:00.000Z');
  });

  it('adds a relative hint to now', () => {
    expect(opencodeCapResetAt([attempt('Resets in 3hr 17min')], now)).toBe(new Date(now + 197 * 60_000).toISOString());
  });

  it('returns the latest reset across attempts', () => {
    expect(opencodeCapResetAt([attempt('Resets in 1hr'), attempt('Resets in 5hr'), attempt()], now)).toBe(
      new Date(now + 5 * 3_600_000).toISOString(),
    );
  });

  it('returns undefined without a detail or hint', () => {
    expect(opencodeCapResetAt([attempt(), attempt('boom')], now)).toBeUndefined();
  });

  it('opencodeCapError keeps reason and attempts and includes the original message', () => {
    const attempts = [attempt('Resets in 1hr')];
    const error = opencodeCapError({
      err: new Error('All models failed'),
      reason: 'usage_cap',
      attempts,
      why: 'no-harness',
      now,
    });
    expect(error).toBeInstanceOf(ModelRouterError);
    expect(error.reason).toBe('usage_cap');
    expect(error.attempts).toBe(attempts);
    expect(error.message).toContain('All models failed');
    expect(error.message).toContain('no other build harness allowed');
  });
});
