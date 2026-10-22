import { describe, expect, it } from 'vitest';

import type { ModelsConfig } from '../config/index.js';
import { ModelRegistry } from './index.js';

function model(overrides: Record<string, unknown> = {}) {
  return {
    provider: 'ollama',
    tier: 'worker',
    costPerMtokInput: 0,
    costPerMtokOutput: 0,
    contextWindow: 1000,
    capabilities: [],
    envKey: null,
    ...overrides,
  };
}

const registry = new ModelRegistry({
  version: 1,
  models: {
    'legacy-inferred': model({ codex: true }),
    'legacy-declared': model({ harness: 'ollama-command-agent' }),
    migrated: model({ codex: true, harness: 'ollama-agentic' }),
    'codex-other': model({ provider: 'openai', codex: true }),
    'ollama-plain': model(),
    typo: model({ harness: 'ollama-commandagent' }),
  },
  tiers: { worker: ['legacy-inferred', 'legacy-declared', 'migrated', 'codex-other', 'ollama-plain', 'typo'] },
  failover: {
    triggers: ['rate_limit', 'usage_cap', 'timeout', 'error', 'empty_response'],
    maxRetries: 2,
    cooldownMs: 0,
    escalateAfterTierExhausted: true,
  },
  routingRules: {},
} as ModelsConfig);

describe('retired ollama-command-agent harness', () => {
  it('resolves both legacy shapes to ollama-agentic', () => {
    expect(registry.getHarnessId('legacy-inferred')).toBe('ollama-agentic');
    expect(registry.getHarnessId('legacy-declared')).toBe('ollama-agentic');
  });

  it('leaves already-migrated, other and typo ids unchanged', () => {
    expect(registry.getHarnessId('migrated')).toBe('ollama-agentic');
    expect(registry.getHarnessId('codex-other')).toBe('codex-cli');
    expect(registry.getHarnessId('ollama-plain')).toBe('ollama-http');
    expect(registry.getHarnessId('typo')).toBe('ollama-commandagent');
    expect(registry.getHarnessId('missing')).toBeUndefined();
  });

  it('reports the retired id only for the two legacy shapes', () => {
    expect(registry.retiredHarnessId('legacy-inferred')).toBe('ollama-command-agent');
    expect(registry.retiredHarnessId('legacy-declared')).toBe('ollama-command-agent');
    for (const id of ['migrated', 'codex-other', 'ollama-plain', 'typo', 'missing']) {
      expect(registry.retiredHarnessId(id)).toBeUndefined();
    }
  });
});
