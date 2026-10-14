import { describe, expect, it } from 'vitest';

import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { ModelRouter } from './index.js';
import { StubModelExecutor } from './stub.js';

describe('ModelRouter.resolveAll requires command', () => {
  it('build_command keeps only models on declared agentic harnesses', () => {
    const base = {
      provider: 'custom' as const,
      tier: 'worker',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
    };
    const declared = { command: 'agent {model}', prompt: 'stdin', output: 'stdout', usage: 'none' } as const;
    const models: ModelsConfig = {
      version: 1,
      models: {
        'declared-agentic': { ...base, harness: 'my-agent' },
        'declared-chat': { ...base, harness: 'chat-only' },
        'claude-model': { ...base, provider: 'anthropic' },
        'codex-model': { ...base, codex: true },
      },
      tiers: { worker: ['declared-agentic', 'declared-chat', 'claude-model', 'codex-model'] },
      failover: { triggers: [], maxRetries: 0, cooldownMs: 0, escalateAfterTierExhausted: false },
      routingRules: {},
      harnesses: {
        'my-agent': { ...declared, agentic: true },
        'chat-only': { ...declared, agentic: false },
      },
    };
    const routes: RoutesConfig = {
      version: 1,
      routes: { build_command: { tier: 'worker', description: 'stub', requires: 'command' } },
    };
    const router = new ModelRouter(models, routes, false, new StubModelExecutor({ scripts: {} }));

    expect(router.resolveAll('build_command')).toEqual(['declared-agentic']);
  });
});
