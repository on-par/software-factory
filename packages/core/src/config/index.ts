// packages/core/src/config/index.ts — Configuration loaders with Zod validation
//
// Config files live in @on-par/factory-config (a separate workspace package
// that ships the JSON configs + constitution markdown). This module loads
// them by resolving the config package's exports, or by explicit path.

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { resolveConfigPath } from '@on-par/factory-config';

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
  codex: z.boolean().optional(),
  codexFlag: z.string().optional(),
  experimental: z.boolean().optional(),
});

const ModelsConfigSchema = z.object({
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
});

const RoutesConfigSchema = z.object({
  version: z.number(),
  routes: z.record(z.string(), z.object({
    tier: z.string(),
    description: z.string(),
    requires: z.string().optional(),
  })),
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
    planSeconds: z.number(),
    buildSeconds: z.number(),
    checkSeconds: z.number(),
    mergePollSeconds: z.number(),
  }),
  merge: z.object({ auto: z.boolean(), comment: z.string() }),
  worktree: z.object({ prefix: z.string(), parent: z.string(), comment: z.string() }),
  byok: z.object({ enabled: z.boolean(), comment: z.string() }),
  notifications: z.record(z.string(), z.boolean()),
  costTracking: z.object({ enabled: z.boolean(), logFile: z.string(), comment: z.string() }),
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
    product: resolve(state, 'product'),
    stop: resolve(state, 'STOP'),
    costs: resolve(state, 'costs.jsonl'),
  };
}

// ---------- Constitution resolution ----------

export function getConstitutionsDir(): string {
  return resolveConfigPath('constitutions');
}