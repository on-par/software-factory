// packages/core/src/config/v2-models.ts — The `models` section of the unified v2 config schema.
// Split out of ./v2.ts to keep that file under the line cap; see its header for the schema notes.

import { defaultModelsConfig } from '@on-par/factory-config';
import { z } from 'zod';

import { ModelEffortsSchema } from './effort.js';
import { PROVIDER_ORDER_DESCRIPTION, providerOrderIssues, type ProviderOrderRole } from './provider-order.js';

const ProviderSchema = z
  .enum(['anthropic', 'openai', 'ollama', 'deepseek', 'custom'])
  .describe('Which backend serves this model.');

const ModelDefSchema = z
  .object({
    provider: ProviderSchema,
    tier: z
      .union([z.string(), z.array(z.string())])
      .describe('Tier name, or list of tier names, this model is eligible for.'),
    costPerMtokInput: z.number().describe('USD cost per million input tokens (0 for local/free models).'),
    costPerMtokOutput: z.number().describe('USD cost per million output tokens (0 for local/free models).'),
    costPerMtokCachedInput: z
      .number()
      .optional()
      .describe(
        'USD cost per million cache-read input tokens. Unset prices cache reads at costPerMtokInput and flags the cost row.',
      ),
    contextWindow: z.number().describe('Maximum context window in tokens.'),
    capabilities: z.array(z.string()).describe('Capability tags (e.g. planning, implementation, review).'),
    envKey: z
      .string()
      .nullable()
      .describe('Environment variable holding this model’s API key, or null for subscription/local auth.'),
    claudeFlag: z.string().optional().describe('Model id passed to the claude CLI harness.'),
    codexFlag: z.string().optional().describe('CLI flags passed to the codex harness (e.g. "-m gpt-5.6-sol").'),
    providerModel: z.string().optional().describe('Provider-native model id for non-claude harnesses.'),
    providerOptions: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('Extra provider-specific options (e.g. Ollama num_ctx/temperature).'),
    endpoint: z
      .url()
      .optional()
      .describe(
        'Approved Anthropic-compatible intermediary base URL (https) for the claude-cli harness. Needs envKey; host must be an ADR-0163 approved intermediary.',
      ),
    harness: z
      .string()
      .optional()
      .describe('Harness id that drives this model (claude-cli, codex-cli, ollama-http, ...).'),
    codex: z.boolean().optional().describe('Marks the model eligible for the build_codex route.'),
    experimental: z.boolean().optional().describe('Requires FACTORY_EXPERIMENTAL=1 to be routable.'),
    trainsOnPrompts: z
      .boolean()
      .optional()
      .describe('Provider may use prompts for training. Never routed from a tier; pin it to use it.'),
  })
  .describe('A single model in the registry: provider, cost, capabilities, and harness wiring.');

const ModelFailoverSchema = z
  .object({
    triggers: z
      .array(z.string())
      .default(['rate_limit', 'usage_cap', 'timeout', 'error', 'empty_response'])
      .describe('Failure reasons that trigger failover to the next model in the tier.'),
    maxRetries: z.number().default(2).describe('Maximum retries before the tier is considered exhausted.'),
    cooldownMs: z.number().default(5000).describe('Delay in milliseconds between failover attempts.'),
    escalateAfterTierExhausted: z
      .boolean()
      .default(true)
      .describe('When a tier is exhausted, escalate to the next-higher tier instead of failing.'),
  })
  .describe('Model-level failover: how the router walks a tier when a model fails.');

const ModelPinsSchema = z
  .object({
    plan: z.string().optional().describe('Pin the PLAN model (overrides tier resolution).'),
    planFallback: z.string().optional().describe('Fallback PLAN model when the pinned plan model is unavailable.'),
    build: z.string().optional().describe('Pin the BUILD model.'),
    buildFallback: z
      .string()
      .optional()
      .describe('Fallback BUILD model; must be Codex-capable (used after a Claude build failure).'),
    checker: z.string().optional().describe('Pin the checker-tier model.'),
    triage: z.string().optional().describe('Pin the triage-tier model.'),
    classifier: z.string().optional().describe('Pin the PR classifier model (classify_pr route).'),
  })
  .describe('Per-phase model pins. Each overrides the default tier resolution for that phase.');

const ProvidersSchema = z
  .object({
    anthropic: z.boolean().optional().describe('Enable/disable Anthropic models (default: enabled).'),
    openai: z.boolean().optional().describe('Enable/disable OpenAI/Codex models (default: enabled).'),
    ollama: z.boolean().optional().describe('Enable/disable local Ollama models (default: enabled).'),
  })
  .describe('Provider on/off switches. Omitting a provider leaves it enabled.');

const providerOrderRole = (role: ProviderOrderRole) =>
  z
    .array(z.string())
    .min(1)
    .default([...defaultModelsConfig.providerOrder[role]]);

export const ModelsSectionSchema = z
  .object({
    registry: z
      .record(z.string(), ModelDefSchema)
      .default({})
      .describe('Model registry: model id -> definition. A sparse overlay adds to the packaged registry.'),
    tiers: z
      .record(z.string(), z.array(z.string()))
      .default({})
      .describe('Tier name -> ordered list of model ids. The router resolves a tier to its first available model.'),
    pins: ModelPinsSchema.prefault({}),
    providerOrder: z
      .object({
        boss: providerOrderRole('boss'),
        worker: providerOrderRole('worker'),
        checker: providerOrderRole('checker'),
        triage: providerOrderRole('triage'),
      })
      .prefault({})
      .describe(PROVIDER_ORDER_DESCRIPTION),
    efforts: ModelEffortsSchema.optional(),
    providers: ProvidersSchema.prefault({}),
    failover: ModelFailoverSchema.prefault({}),
    routingRules: z
      .record(z.string(), z.unknown())
      .default({})
      .describe('Conditional routing hints (codex_available, ollama_available, byok_active, ...).'),
  })
  .superRefine((section, ctx) => {
    const models = { ...defaultModelsConfig.models, ...section.registry };
    for (const issue of providerOrderIssues(section.providerOrder, models)) {
      ctx.addIssue({ code: 'custom', path: ['providerOrder', issue.role, issue.index], message: issue.message });
    }
  })
  .describe('Model registry, tiers, per-phase pins, provider switches, and failover behavior.');
