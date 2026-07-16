// packages/core/src/config/index.ts — Configuration loaders with Zod validation
//
// Config files live in @on-par/factory-config (a separate workspace package
// that ships the JSON configs + constitution markdown). This module loads
// them by resolving the config package's exports, or by explicit path.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { resolveConfigPath } from '@on-par/factory-config';
import { KNOWN_HARNESS_IDS } from '../harness/catalog.js';

// ---------- Schemas ----------

const ModelDefSchema = z.object({
  provider: z.enum(['anthropic', 'openai', 'ollama', 'deepseek', 'custom']),
  tier: z.union([z.string(), z.array(z.string())]),
  costPerMtokInput: z.number(),
  costPerMtokOutput: z.number(),
  contextWindow: z.number(),
  capabilities: z.array(z.string()),
  envKey: z.string().nullable(),
  claudeFlag: z.string().optional(),
  providerModel: z.string().optional(),
  providerOptions: z.record(z.string(), z.unknown()).optional(),
  codex: z.boolean().optional(),
  codexFlag: z.string().optional(),
  harness: z.string().optional(),
  experimental: z.boolean().optional(),
});

const ModelsConfigSchema = z
  .object({
    version: z.number(),
    models: z.record(z.string(), ModelDefSchema),
    tiers: z.record(z.string(), z.array(z.string())),
    failover: z.object({
      triggers: z.array(z.string()),
      maxRetries: z.number(),
      cooldownMs: z.number(),
      escalateAfterTierExhausted: z.boolean(),
    }),
    routingRules: z.record(z.string(), z.unknown()).default({}),
  })
  .superRefine((config, ctx) => {
    for (const [name, def] of Object.entries(config.models)) {
      if (def.harness !== undefined && !KNOWN_HARNESS_IDS.includes(def.harness)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['models', name, 'harness'],
          message: `Model '${name}' declares unknown harness '${def.harness}' (known harnesses: ${KNOWN_HARNESS_IDS.join(', ')})`,
        });
      }
    }
  });

const RoutesConfigSchema = z.object({
  version: z.number(),
  routes: z.record(
    z.string(),
    z.object({
      tier: z.string(),
      description: z.string(),
      requires: z.string().optional(),
    }),
  ),
});

const FactoryConfigSchema = z.object({
  version: z.number(),
  paths: z.object({
    constitutions: z.string(),
    checkers: z.string(),
    plans: z.string(),
    logs: z.string(),
    events: z.string(),
  }),
  timeouts: z.object({
    plan_seconds: z.number(),
    build_seconds: z.number(),
    check_seconds: z.number(),
    merge_poll_seconds: z.number(),
    approval_seconds: z.number().default(1800),
  }),
  merge: z.object({ auto: z.boolean(), comment: z.string() }),
  worktree: z.object({
    prefix: z.string(),
    parent: z.string(),
    comment: z.string(),
    gcTtlDays: z.number().default(7),
    autoGcOnRun: z.boolean().default(true),
  }),
  byok: z.object({ enabled: z.boolean(), comment: z.string() }),
  notifications: z.record(z.string(), z.boolean()),
  cost_tracking: z.object({ enabled: z.boolean(), log_file: z.string(), comment: z.string() }),
  ci: z
    .object({
      skip: z.boolean().default(false),
      comment: z.string().default('Set FACTORY_SKIP_CI=1 to skip waiting for GitHub Actions CI before merging'),
    })
    .default({ skip: false, comment: 'Set FACTORY_SKIP_CI=1 to skip waiting for GitHub Actions CI before merging' }),
});

// ---------- Types ----------

export type ModelsConfig = z.infer<typeof ModelsConfigSchema>;
export type RoutesConfig = z.infer<typeof RoutesConfigSchema>;
export type FactoryConfig = z.infer<typeof FactoryConfigSchema>;

// ---------- Loaders ----------

export function loadModelsConfig(path?: string): ModelsConfig {
  const p = path ?? resolveConfigPath('models.json');
  const raw = JSON.parse(readFileSync(p, 'utf-8'));
  return ModelsConfigSchema.parse(raw);
}

export function loadRoutesConfig(path?: string): RoutesConfig {
  const p = path ?? resolveConfigPath('routes.json');
  const raw = JSON.parse(readFileSync(p, 'utf-8'));
  return RoutesConfigSchema.parse(raw);
}

export function loadFactoryConfig(path?: string): FactoryConfig {
  const p = path ?? resolveConfigPath('factory.json');
  const raw = JSON.parse(readFileSync(p, 'utf-8'));
  return FactoryConfigSchema.parse(raw);
}

export function resolveTimeouts(
  config: FactoryConfig,
  env: NodeJS.ProcessEnv = process.env,
): { plan: number; build: number; check: number; approval: number } {
  const fromEnv = (v?: string) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };

  return {
    plan: fromEnv(env.FACTORY_PLAN_TIMEOUT) ?? config.timeouts.plan_seconds ?? 1800,
    build: fromEnv(env.FACTORY_BUILD_TIMEOUT) ?? config.timeouts.build_seconds ?? 7200,
    check: fromEnv(env.FACTORY_CHECK_TIMEOUT) ?? config.timeouts.check_seconds ?? 1800,
    approval: fromEnv(env.FACTORY_APPROVAL_TIMEOUT) ?? config.timeouts.approval_seconds ?? 1800,
  };
}

export function resolveSkipCI(config: FactoryConfig, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.FACTORY_SKIP_CI === '1') return true;
  if (env.FACTORY_SKIP_CI === '0') return false;
  return config.ci?.skip ?? false;
}

// ---------- Factory state paths ----------

export function getFactoryPaths(repoRoot: string) {
  const state = resolve(repoRoot, '.factory');
  return {
    state,
    queue: resolve(state, 'queue'),
    queueProposed: resolve(state, 'queue.proposed'),
    events: resolve(state, 'events.ndjson'),
    logs: resolve(state, 'logs'),
    plans: resolve(state, 'plans'),
    reports: resolve(state, 'reports'),
    mergeLock: resolve(state, 'merge.lock'),
    gitLock: resolve(state, 'git.lock'),
    product: resolve(state, 'product'),
    stop: resolve(state, 'STOP'),
    costs: resolve(state, 'costs.jsonl'),
    approvals: resolve(state, 'approvals'),
  };
}

// ---------- Constitution resolution ----------

export function getConstitutionsDir(): string {
  return resolveConfigPath('constitutions');
}
