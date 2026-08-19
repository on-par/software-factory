import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { defaultFactoryConfig, defaultModelsConfig, defaultRoutesConfig } from './defaults.js';

describe('shipped defaults', () => {
  it('has 20 models with the expected harness-bearing spot checks', () => {
    const modelIds = Object.keys(defaultModelsConfig.models);
    expect(modelIds).toHaveLength(20);

    expect(defaultModelsConfig.models['claude-fable-5'].harness).toBe('claude-cli');
    expect(defaultModelsConfig.models['gpt-5.6-terra-high'].harness).toBe('codex-cli');
    expect(defaultModelsConfig.models['qwen3.5:9b'].harness).toBe('ollama-http');
    expect(defaultModelsConfig.models['codex-ollama-qwen3.5:9b'].harness).toBe('ollama-agentic');
    expect(defaultModelsConfig.models['opencode-deepseek-v4-flash-free'].harness).toBe('opencode');
  });

  it('every tier entry exists in models, with the expected tier lengths', () => {
    const modelIds = new Set(Object.keys(defaultModelsConfig.models));

    for (const [tier, ids] of Object.entries(defaultModelsConfig.tiers)) {
      for (const id of ids) {
        expect(modelIds.has(id), `tier '${tier}' references unknown model '${id}'`).toBe(true);
      }
    }

    expect(defaultModelsConfig.tiers.boss).toHaveLength(8);
    expect(defaultModelsConfig.tiers.worker).toHaveLength(13);
    expect(defaultModelsConfig.tiers.checker).toHaveLength(7);
    expect(defaultModelsConfig.tiers.triage).toHaveLength(3);
  });

  it('has the expected failover policy', () => {
    expect(defaultModelsConfig.failover).toEqual({
      triggers: ['rate_limit', 'usage_cap', 'timeout', 'error', 'empty_response'],
      maxRetries: 2,
      cooldownMs: 5000,
      escalateAfterTierExhausted: true,
    });
  });

  it('has 18 routes, each pointing at a known tier', () => {
    const routeIds = Object.keys(defaultRoutesConfig.routes);
    expect(routeIds).toHaveLength(18);

    const tierIds = new Set(Object.keys(defaultModelsConfig.tiers));
    for (const [route, def] of Object.entries(defaultRoutesConfig.routes)) {
      expect(tierIds.has(def.tier), `route '${route}' references unknown tier '${def.tier}'`).toBe(true);
    }

    expect(defaultRoutesConfig.routes.build_codex.requires).toBe('codex');
  });

  it('has the expected factory defaults', () => {
    expect(defaultFactoryConfig.timeouts.plan_seconds).toBe(1800);
    expect(defaultFactoryConfig.timeouts.build_seconds).toBe(7200);
    expect(defaultFactoryConfig.worktree.gcTtlDays).toBe(7);
    expect(defaultFactoryConfig.filing.maxPerDay).toBe(20);
    expect(defaultFactoryConfig.ingest.maxPerCycle).toBe(20);
  });
});

describe('no JSON ships from this package', () => {
  it('has no .json / .json.bak files under src or dist', () => {
    const offenders: string[] = [];

    for (const dir of ['src', 'dist']) {
      const abs = fileURLToPath(new URL(`../${dir}/`, import.meta.url));
      let entries: string[];
      try {
        entries = readdirSync(abs, { recursive: true }) as string[];
      } catch {
        continue; // dist doesn't exist before a build — that's fine
      }
      for (const entry of entries) {
        if (entry.endsWith('.json') || entry.endsWith('.json.bak')) {
          offenders.push(`${dir}/${entry}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
