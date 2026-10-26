import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  defaultEvidenceCaps,
  defaultFactoryConfig,
  defaultLaneBreakerThreshold,
  defaultModelsConfig,
  defaultRoutesConfig,
  retiredModels,
  type ModelDefaults,
} from './defaults.js';

describe('shipped defaults', () => {
  it('ships the default PR footer', () => {
    expect(defaultFactoryConfig.pr.footer).toBe('This PR was made by Software Factory');
  });

  it('defaults the review-rework cap to 2 (#3565)', () => {
    expect(defaultFactoryConfig.queue.max_review_rework_runs).toBe(2);
  });

  it('defaults the lane breaker threshold to 2 (#1915)', () => {
    expect(defaultLaneBreakerThreshold).toBe(2);
  });

  it('describes build_claude as driving its own commits without publishing (#1870)', () => {
    const description = defaultRoutesConfig.routes['build_claude']?.description ?? '';
    expect(description).toContain('drives its own commits');
    expect(description).toContain('commit-only');
    expect(description).not.toMatch(/\bpush|pull request|\bopens? (a )?PR\b|wait(s)? for CI/i);
  });

  it('defaults the host-wide agent job cap to 1 (#3047)', () => {
    expect(defaultFactoryConfig.host.maxAgentJobs).toBe(1);
  });

  it('grants no Codex task full access by default', () => {
    expect(defaultFactoryConfig.sandbox.codexFullAccessTasks).toEqual([]);
  });

  it('defaults the host-wide BUILD/CHECK cap to 2 (#3043)', () => {
    expect(defaultFactoryConfig.host.maxBuilds).toBe(2);
  });

  it('enables the host load guard by default (#3048)', () => {
    expect(defaultFactoryConfig.host.loadGuard).toEqual({ enabled: true, retrySeconds: 60 });
  });

  it('defaults intake to warn with no trusted approvers', () => {
    expect(defaultFactoryConfig.intake.enforce).toBe('warn');
    expect(defaultFactoryConfig.intake.trustedApprovers).toBeUndefined();
  });

  it('ships no deepseek-v3 model and no tier lists it (ADR-0163)', () => {
    expect(Object.hasOwn(defaultModelsConfig.models, 'deepseek-v3')).toBe(false);
    for (const [tier, ids] of Object.entries(defaultModelsConfig.tiers)) {
      expect(ids, `tier '${tier}'`).not.toContain('deepseek-v3');
    }
  });

  it('ships no direct DeepSeek model (ADR-0163)', () => {
    for (const [id, model] of Object.entries(defaultModelsConfig.models)) {
      expect(model.provider, `model '${id}' provider`).not.toBe('deepseek');
      expect(model.envKey, `model '${id}' envKey`).not.toBe('DEEPSEEK_API_KEY');
    }
  });

  it('points the retired deepseek-v3 at a packaged replacement (ADR-0163)', () => {
    const retired = retiredModels['deepseek-v3'];
    expect(retired?.adr).toBe('ADR-0163');
    expect(defaultModelsConfig.models[retired?.replacement ?? '']).toBeDefined();
  });

  it('has 26 models with the expected harness-bearing spot checks', () => {
    const modelIds = Object.keys(defaultModelsConfig.models);
    expect(modelIds).toHaveLength(26);

    for (const id of [
      'claude-opus-5',
      'claude-opus-5-5',
      'claude-fable-5',
      'claude-sonnet-5',
      'claude-sonnet-5-5',
      'claude-haiku-5-5',
      'gpt-5.6-terra-high',
      'gpt-5.6-terra-medium',
      'gpt-5.6-luna-high',
      'gpt-6-astra',
      'gpt-5.6-sol',
      'gpt-5.1-codex',
      'opencode-deepseek-v4-flash',
      'opencode-deepseek-v4-pro',
      'pi-openrouter-deepseek-v4-flash',
      'pi-openrouter-deepseek-v4-pro',
      'qwen2.5-coder:14b',
    ]) {
      expect(modelIds, `missing model ${id}`).toContain(id);
    }

    expect(defaultModelsConfig.models['claude-fable-5'].harness).toBe('claude-cli');
    expect(defaultModelsConfig.models['gpt-5.6-terra-high'].harness).toBe('codex-cli');
    expect(defaultModelsConfig.models['gpt-5.6-luna-high'].harness).toBe('codex-cli');
    expect(defaultModelsConfig.models['qwen3.5:9b'].harness).toBe('ollama-http');
    expect(defaultModelsConfig.models['codex-ollama-qwen3.5:9b'].harness).toBe('ollama-agentic');
    expect(defaultModelsConfig.models['opencode-deepseek-v4-flash'].harness).toBe('opencode');
    expect(defaultModelsConfig.models['pi-openrouter-deepseek-v4-flash'].harness).toBe('pi');
  });

  it('registers pi-openrouter-deepseek-v4-flash and -pro as experimental pin-only Pi models via OpenRouter (#2904)', () => {
    for (const id of ['pi-openrouter-deepseek-v4-flash', 'pi-openrouter-deepseek-v4-pro']) {
      const model = defaultModelsConfig.models[id];
      expect(model, id).toMatchObject({
        provider: 'custom',
        harness: 'pi',
        envKey: 'OPENROUTER_API_KEY',
        contextWindow: 1000000,
        experimental: true,
      });
      expect(model.providerModel, id).toMatch(/^openrouter\/deepseek\//);
      for (const list of Object.values(defaultModelsConfig.tiers)) {
        expect(list, id).not.toContain(id);
      }
    }
  });

  it('registers claude-openrouter-deepseek-v4-flash as an experimental pin-only claude-cli model via OpenRouter (#2908)', () => {
    const id = 'claude-openrouter-deepseek-v4-flash';
    const model = defaultModelsConfig.models[id];
    expect(model).toMatchObject({
      provider: 'custom',
      harness: 'claude-cli',
      endpoint: 'https://openrouter.ai/api',
      envKey: 'OPENROUTER_API_KEY',
      claudeFlag: 'deepseek/deepseek-v4.1-flash',
      experimental: true,
    });
    // config cannot import core, so the host is asserted literally. Keep it in sync with the
    // approved list in packages/core/src/config/intermediaries.ts.
    const url = new URL(model.endpoint!);
    expect(url.protocol).toBe('https:');
    expect(url.hostname).toBe('openrouter.ai');
    expect(model.costPerMtokInput).toBeGreaterThan(0);
    expect(model.costPerMtokOutput).toBeGreaterThan(0);
    for (const list of Object.values(defaultModelsConfig.tiers)) {
      expect(list).not.toContain(id);
    }
  });

  it('documents dated tools, thinking and ZDR verification in the claude-openrouter-deepseek-v4-flash JSDoc (#2908)', () => {
    const lines = readFileSync(new URL('./defaults.ts', import.meta.url), 'utf8').split('\n');
    const idx = lines.findIndex((l) => l.includes("'claude-openrouter-deepseek-v4-flash': {"));
    expect(idx).toBeGreaterThan(0);
    const doc = lines[idx - 1];
    expect(doc).toMatch(/Verified \d{4}-\d{2}-\d{2}/);
    expect(doc).toMatch(/tools (PASS|FAIL)/i);
    expect(doc).toMatch(/thinking (PASS|FAIL)/i);
    expect(doc).toMatch(/ZDR (PASS|FAIL)/i);
    expect(doc).toContain('live `claude -p`');
  });

  it('ships no pi model with an azure/ or deepseek/ prefix (ADR-0163)', () => {
    for (const [id, model] of Object.entries(defaultModelsConfig.models)) {
      if (model.harness !== 'pi') continue;
      const pm = model.providerModel?.toLowerCase();
      expect(pm, id).toBeDefined();
      expect(pm!.startsWith('azure/'), id).toBe(false);
      expect(pm!.startsWith('deepseek/'), id).toBe(false);
    }
  });

  it('points opencode-deepseek-v4-flash at OpenCode Go V4.1 Flash at the published prices (#2898)', () => {
    expect(defaultModelsConfig.models['opencode-deepseek-v4-flash']).toMatchObject({
      harness: 'opencode',
      providerModel: 'opencode-go/deepseek-v4.1-flash',
      costPerMtokInput: 0.3,
      costPerMtokOutput: 1.2,
      envKey: 'OPENCODE_API_KEY',
    });
  });

  it('registers opencode-deepseek-v4-pro as an experimental pin-only OpenCode Go model (#2898)', () => {
    expect(defaultModelsConfig.models['opencode-deepseek-v4-pro']).toMatchObject({
      harness: 'opencode',
      providerModel: 'opencode-go/deepseek-v4-pro',
      envKey: 'OPENCODE_API_KEY',
      contextWindow: 1000000,
      costPerMtokInput: 1.74,
      costPerMtokOutput: 3.48,
      experimental: true,
    });
    for (const ids of Object.values(defaultModelsConfig.tiers)) {
      expect(ids).not.toContain('opencode-deepseek-v4-pro');
    }
  });

  it('offers Astra through subscription-authenticated Codex without changing tier defaults', () => {
    expect(defaultModelsConfig.models['gpt-6-astra']).toMatchObject({
      provider: 'openai',
      codex: true,
      harness: 'codex-cli',
      envKey: null,
      codexFlag: '-m gpt-6-astra -c model_reasoning_effort=medium',
    });
  });

  it('registers Opus 5.5 and Sonnet 5.5 for repo pins without adding them to any default tier', () => {
    expect(defaultModelsConfig.models['claude-opus-5-5']).toMatchObject({
      provider: 'anthropic',
      tier: 'boss',
      costPerMtokInput: 4,
      costPerMtokOutput: 20,
      envKey: null,
      harness: 'claude-cli',
      claudeFlag: 'claude-opus-5-5',
    });
    expect(defaultModelsConfig.models['claude-sonnet-5-5']).toMatchObject({
      provider: 'anthropic',
      tier: ['checker', 'boss_fallback', 'worker_fallback'],
      costPerMtokInput: 2,
      costPerMtokOutput: 10,
      envKey: null,
      harness: 'claude-cli',
      claudeFlag: 'claude-sonnet-5-5',
    });

    for (const ids of Object.values(defaultModelsConfig.tiers)) {
      expect(ids).not.toContain('claude-opus-5-5');
      expect(ids).not.toContain('claude-sonnet-5-5');
    }
  });

  it('every tier entry exists in models, with the expected tier lengths', () => {
    const modelIds = new Set(Object.keys(defaultModelsConfig.models));

    for (const [tier, ids] of Object.entries(defaultModelsConfig.tiers)) {
      for (const id of ids) {
        expect(modelIds.has(id), `tier '${tier}' references unknown model '${id}'`).toBe(true);
      }
    }

    expect(defaultModelsConfig.tiers.boss).toHaveLength(8);
    expect(defaultModelsConfig.tiers.worker).toHaveLength(11);
    expect(defaultModelsConfig.tiers.checker).toHaveLength(7);
    expect(defaultModelsConfig.tiers.triage).toHaveLength(4);
    expect(defaultModelsConfig.tiers.triage_cheap).toHaveLength(5);
  });

  it('ships no OpenCode Zen (opencode/) model (#3334)', () => {
    for (const [id, def] of Object.entries(defaultModelsConfig.models)) {
      expect(id.startsWith('opencode/'), id).toBe(false);
      expect(def.providerModel?.startsWith('opencode/') ?? false, id).toBe(false);
    }
    expect(defaultModelsConfig.models['opencode-deepseek-v4-flash-free']).toBeUndefined();
  });

  it('ships the per-role providerOrder lists (#3334)', () => {
    expect(defaultModelsConfig.providerOrder).toEqual({
      boss: ['claude-opus-5', 'gpt-5.6-terra-high', 'opencode-deepseek-v4-flash'],
      worker: ['gpt-5.6-terra-medium', 'claude-sonnet-5', 'opencode-deepseek-v4-flash'],
      checker: ['claude-sonnet-5', 'gpt-5.6-luna-high', 'opencode-deepseek-v4-flash'],
      triage: ['claude-sonnet-5', 'gpt-5.6-luna-high', 'opencode-deepseek-v4-flash'],
    });
  });

  it('lists no trainsOnPrompts model in a tier', () => {
    const tiered = new Set(Object.values(defaultModelsConfig.tiers).flat());
    expect(tiered.has('opencode-deepseek-v4-flash-free')).toBe(false);
    for (const [id, def] of Object.entries(defaultModelsConfig.models)) {
      if (def.trainsOnPrompts) expect(tiered.has(id), `trainsOnPrompts model '${id}' is in a tier`).toBe(false);
    }
  });

  it('preserves tier order invariants the router depends on', () => {
    expect(defaultModelsConfig.tiers.boss[0]).toBe('claude-opus-5');

    const workerIdx = (id: string) => defaultModelsConfig.tiers.worker.indexOf(id);
    expect(workerIdx('gpt-5.6-terra-medium')).toBeGreaterThanOrEqual(0);
    expect(workerIdx('gpt-5.6-terra-medium')).toBeLessThan(workerIdx('gpt-5.6-sol'));
    expect(workerIdx('gpt-5.6-sol')).toBeLessThan(workerIdx('gpt-5.1-codex'));

    const checkerIdx = (id: string) => defaultModelsConfig.tiers.checker.indexOf(id);
    expect(checkerIdx('claude-sonnet-5')).toBeGreaterThanOrEqual(0);
    expect(checkerIdx('claude-sonnet-5')).toBeLessThan(checkerIdx('gpt-5.6-luna-high'));
    expect(checkerIdx('gpt-5.6-luna-high')).toBeGreaterThanOrEqual(0);
  });

  it('has the expected failover policy', () => {
    expect(defaultModelsConfig.failover).toEqual({
      triggers: ['rate_limit', 'unavailable', 'auth'],
      maxRetries: 2,
      cooldownMs: 5000,
    });
  });

  it('has 24 routes, each pointing at a known tier', () => {
    const routeIds = Object.keys(defaultRoutesConfig.routes);
    expect(routeIds).toHaveLength(24);

    const tierIds = new Set(Object.keys(defaultModelsConfig.tiers));
    for (const [route, def] of Object.entries(defaultRoutesConfig.routes)) {
      expect(tierIds.has(def.tier), `route '${route}' references unknown tier '${def.tier}'`).toBe(true);
    }

    expect(defaultRoutesConfig.routes.build_codex.requires).toBe('codex');
  });

  it('has the expected factory defaults', () => {
    expect(defaultFactoryConfig.worktree).not.toHaveProperty('prefix');
    expect(defaultFactoryConfig.timeouts.plan_seconds).toBe(1800);
    expect(defaultFactoryConfig.sizeGate.mode).toBe('file');
    expect(defaultFactoryConfig.sizeGate.maxSlices).toBe(10);
    expect(defaultFactoryConfig.timeouts.build_seconds).toBe(7200);
    expect(defaultFactoryConfig.worktree.gcTtlDays).toBe(7);
    expect(defaultFactoryConfig.filing.maxPerDay).toBe(20);
    expect(defaultFactoryConfig.ingest.maxPerCycle).toBe(20);
    expect(defaultFactoryConfig.design.blockUnresolvedRegressions).toBe(false);
    expect(defaultFactoryConfig.readiness.updateIssueBody).toBe(true);
  });
});

describe('evidence caps (#1842)', () => {
  it('ships the default excerpt and body caps', () => {
    expect(defaultEvidenceCaps).toEqual({ maxExcerptChars: 2000, maxBodyChars: 8000 });
    expect(defaultEvidenceCaps.maxExcerptChars).toBeLessThan(defaultEvidenceCaps.maxBodyChars);
  });
});

describe('docs live as JSDoc, not as note/comment data', () => {
  // Every model's `note` and the top-level `description` were dropped as data and moved to JSDoc,
  // since ModelDefSchema/ModelsConfigSchema/RoutesConfigSchema strip both at parse time (#716) — so
  // this walk asserts no stray `note` key survives outside the one place it must: `routingRules`
  // entries validate as `z.unknown()`, which does NOT strip unrecognized keys, so dropping `note`
  // there would desync loadModelsConfig()'s no-path output from what the deleted models.json
  // produced. Likewise `comment` is allowed only at the four paths FactoryConfigSchema requires it
  // (merge/worktree/byok/cost_tracking) plus the ten schema-optional-but-not-stripped paths this
  // package deliberately keeps for byte-identical loadFactoryConfig() output (see the comment above
  // `kpis` in defaults.ts).
  const REQUIRED_COMMENT_PATHS = new Set(['merge', 'worktree', 'byok', 'cost_tracking']);
  const OPTIONAL_PRESERVED_COMMENT_PATHS = new Set([
    'kpis',
    'ci',
    'sweep',
    'plan_approval',
    'sandbox',
    'discovery',
    'filing',
    'ingest',
    'environment.ports',
    'environment.proxy',
    'auto_failover',
    'queue',
    'host',
    'disk',
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

  it('only carries a comment data field at the four required plus ten byte-identical-preserved paths', () => {
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

describe('detect_checks route', () => {
  it('is a tool-less JSON call on the triage tier', () => {
    expect(defaultRoutesConfig.routes.detect_checks).toMatchObject({
      tier: 'triage',
      allowedTools: [],
      output: 'json',
    });
  });
});

describe('readiness_judge route (#3467)', () => {
  const route = defaultRoutesConfig.routes.readiness_judge;

  it('is a tool-less JSON route on the triage_cheap tier with no model pin', () => {
    expect(route?.tier).toBe('triage_cheap');
    expect(route?.model).toBeUndefined();
    expect(route?.allowedTools).toEqual([]);
    expect(route?.output).toBe('json');
  });
});

describe('steward route (#2111)', () => {
  const route = defaultRoutesConfig.routes.steward;

  it('has no packaged model pin and resolves from the boss tier', () => {
    expect(route?.model).toBeUndefined();
    expect(route?.tier).toBe('boss');
  });

  it('is tool-less', () => {
    expect(route?.allowedTools).toEqual([]);
  });

  it('declares JSON output', () => {
    expect(route?.output).toBe('json');
  });

  it('leaves every route without a model pin, and every route but steward, detect_checks, readiness_judge and issue_draft without allowedTools/output', () => {
    for (const [id, def] of Object.entries(defaultRoutesConfig.routes)) {
      expect(def.model, id).toBeUndefined();
      if (id === 'issue_draft') {
        expect(def.output, id).toBeUndefined();
        continue;
      }
      if (id === 'steward' || id === 'detect_checks' || id === 'readiness_judge') continue;
      expect(def.allowedTools, id).toBeUndefined();
      expect(def.output, id).toBeUndefined();
    }
  });

  it('ships a tool-less triage issue_draft route (#3171)', () => {
    const route = defaultRoutesConfig.routes.issue_draft;
    expect(route?.tier).toBe('triage');
    expect(route?.allowedTools).toEqual([]);
    expect(route?.output).toBeUndefined();
  });

  it('ships no model that pairs the claude-cli harness with a non-anthropic provider unless it sets an endpoint', () => {
    const offenders = claudeCliOffenders(defaultModelsConfig.models);
    expect(offenders).toEqual([]);
    expect(defaultModelsConfig.tiers.checker).not.toContain('gpt-4.1-mini');
  });

  it('exempts a claude-cli model with an endpoint from the non-anthropic guard', () => {
    const base = { ...defaultModelsConfig.models['claude-fable-5'], provider: 'custom' as const };
    expect(claudeCliOffenders({ a: base, b: { ...base, endpoint: 'https://openrouter.ai/api' } })).toEqual(['a']);
  });
});

function claudeCliOffenders(models: Record<string, ModelDefaults>): string[] {
  return Object.entries(models)
    .filter(([, def]) => {
      const harness =
        def.harness ??
        (def.codex && def.provider === 'ollama'
          ? 'ollama-agentic'
          : def.codex
            ? 'codex-cli'
            : def.provider === 'ollama'
              ? 'ollama-http'
              : 'claude-cli');
      return harness === 'claude-cli' && def.provider !== 'anthropic' && !def.endpoint;
    })
    .map(([id]) => id);
}
