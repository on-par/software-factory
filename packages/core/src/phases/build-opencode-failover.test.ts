import { describe, expect, it } from 'vitest';

import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { ModelRouter } from '../router/index.js';
import { pickOpencodeFallback } from './build-opencode-failover.js';

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
