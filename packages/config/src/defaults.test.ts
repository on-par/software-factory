import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { defaultFactoryConfig, defaultModelsConfig, defaultRoutesConfig } from './defaults.js';

describe('shipped defaults', () => {
  it('has 20 models with the expected harness-bearing spot checks', () => {
    const modelIds = Object.keys(defaultModelsConfig.models);
    expect(modelIds).toHaveLength(20);

    for (const id of [
      'claude-opus-5',
      'claude-fable-5',
      'claude-sonnet-5',
      'gpt-5.6-terra-high',
      'gpt-5.6-terra-medium',
      'gpt-5.6-sol',
      'gpt-5.1-codex',
      'opencode-deepseek-v4-flash-free',
      'qwen2.5-coder:14b',
    ]) {
      expect(modelIds, `missing model ${id}`).toContain(id);
    }

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

  it('preserves tier order invariants the router depends on', () => {
    expect(defaultModelsConfig.tiers.boss[0]).toBe('claude-opus-5');

    const workerIdx = (id: string) => defaultModelsConfig.tiers.worker.indexOf(id);
    expect(workerIdx('gpt-5.6-terra-medium')).toBeGreaterThanOrEqual(0);
    expect(workerIdx('gpt-5.6-terra-medium')).toBeLessThan(workerIdx('gpt-5.6-sol'));
    expect(workerIdx('gpt-5.6-sol')).toBeLessThan(workerIdx('gpt-5.1-codex'));
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

describe('docs live as JSDoc, not as note/comment data', () => {
  // Every model's `note` and the top-level `description` were dropped as data and moved to JSDoc,
  // since ModelDefSchema/ModelsConfigSchema/RoutesConfigSchema strip both at parse time (#716) — so
  // this walk asserts no stray `note` key survives outside the one place it must: `routingRules`
  // entries validate as `z.unknown()`, which does NOT strip unrecognized keys, so dropping `note`
  // there would desync loadModelsConfig()'s no-path output from what the deleted models.json
  // produced. Likewise `comment` is allowed only at the four paths FactoryConfigSchema requires it
  // (merge/worktree/byok/cost_tracking) plus the nine schema-optional-but-not-stripped paths this
  // package deliberately keeps for byte-identical loadFactoryConfig() output (see the comment above
  // `kpis` in defaults.ts).
  const REQUIRED_COMMENT_PATHS = new Set(['merge', 'worktree', 'byok', 'cost_tracking']);
  const OPTIONAL_PRESERVED_COMMENT_PATHS = new Set([
    'kpis',
    'ci',
    'plan_approval',
    'sandbox',
    'discovery',
    'filing',
    'ingest',
    'environment.ports',
    'environment.proxy',
    'auto_failover',
  ]);
  const ALLOWED_COMMENT_PATHS = new Set([...REQUIRED_COMMENT_PATHS, ...OPTIONAL_PRESERVED_COMMENT_PATHS]);

  function walk(value: unknown, path: string[], allowNote: boolean) {
    if (value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach((item, i) => walk(item, [...path, String(i)], allowNote));
      return;
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const childPath = [...path, key];
      if (key === 'note' && !allowNote) {
        expect.fail(`unexpected 'note' data field at ${childPath.join('.')} — should be JSDoc, not data`);
      }
      if (key === 'comment') {
        expect(
          ALLOWED_COMMENT_PATHS.has(path.join('.')),
          `unexpected 'comment' data field at ${childPath.join('.')}`,
        ).toBe(true);
      }
      // Once inside routingRules, note is data by design — stop enforcing note-freedom below it.
      const nextAllowNote = allowNote || (path.length === 0 && key === 'routingRules');
      walk(child, childPath, nextAllowNote);
    }
  }

  it('carries model/route docs as JSDoc, never as a note data field (routingRules.*.note is the documented exception)', () => {
    walk(defaultModelsConfig, [], false);
    walk(defaultRoutesConfig, [], false);
  });

  it('only carries a comment data field at the four required plus nine byte-identical-preserved paths', () => {
    walk(defaultFactoryConfig, [], true);
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
