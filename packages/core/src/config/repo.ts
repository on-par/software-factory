// src/config/repo.ts — Per-repo model/runtime config overrides (.factory/config.yaml|yml|json): pins, tiers,
// providers, budget and more, over the packaged defaults. Resolution order: repo file > env vars > packaged defaults.

import { existsSync } from 'node:fs';

import { defaultLaneBreakerThreshold } from '@on-par/factory-config';
import { z } from 'zod';
import { readRepoConfigFile } from './repo-config-file.js';
import { resolvePrecedence, type ConfigSource } from './precedence.js';
import { runConfigSource } from './run-config-source.js';
import { HealthConfigSections } from './base-health.js';
import { OptionalConfigSections } from './optional-sections.js';
import {
  loadFactoryConfig,
  resolveMergePolicy,
  resolvePrClassifierPolicy,
  toConfigSchemaIssues,
  type ConfigSchemaIssue,
} from './index.js';

import type { ModelRegistry } from '../models/index.js';
import { resolveModelOverrides, retiredModelHint } from '../models/index.js';
import type { ModelRouter } from '../router/index.js';
import { applyReviewFloorOverrides, type ReviewFloorRuleSet } from '../review/floor.js';
import {
  FACTORY_RUNTIME_CONFIG_KEYS,
  getFactoryPaths,
  isPlainObject,
  ModelDefSchema,
  resolveBranchPrefix,
  resolveExperimental,
  resolveLocalOnly,
  type EffectiveMergePolicy,
  type EffectivePrClassifierPolicy,
  type ModelsConfig,
} from './index.js';
import { assertRegistryHarness, RepoHarnessesSchema, resolveRepoHarnesses } from './repo-harnesses.js';
import { ModelEffortsSchema } from './effort.js';
import {
  deriveProviderOrder,
  PROVIDER_ORDER_DESCRIPTION,
  ProviderOrderOverrideSchema,
  providerOrderIssues,
} from './provider-order.js';
import { resolveEffectiveBuildRoute } from './build-route.js';
import { assertAgenticBuildPin } from './repo-build-pin.js';
import { assertTierMayRoute } from './repo-tier-guard.js';
import { assertApprovedClaudeEndpoint, assertNoDirectDeepSeek } from './intermediaries.js';
import { ChecksConfigSections } from './checks-section.js';
import { PrConfigSections } from './pr-section.js';

// ---------- Schema ----------

const EVIDENCE_COMMANDS_DESCRIPTION =
  'Named evidence commands for design-artifact evidence plans (not the CHECK build/test/lint commands; see `checks`). Shell-free argv; config overrides scripts.';
export const RepoFactoryConfigV1Schema = z
  .object({
    $schema: z.string().optional(),
    version: z.literal(1).default(1),
    models: z
      .object({
        plan: z.string().optional(),
        planFallback: z.string().optional(),
        build: z.string().optional(),
        buildFallback: z.string().optional(),
        checker: z.string().optional(),
        triage: z.string().optional(),
      })
      .strict()
      .optional(),
    tiers: z.record(z.string(), z.array(z.string())).optional(),
    providers: z
      .object({
        anthropic: z.boolean().optional(),
        openai: z.boolean().optional(),
        ollama: z.boolean().optional(),
      })
      .strict()
      .optional(),
    usage: z.object({ capUsd: z.number().positive().optional() }).strict().optional(),
    /** Opt-in controls that trade expensive exploration/retries for bounded work. */
    efficiency: z
      .object({
        fastPath: z.boolean().optional(),
        maxReworkRounds: z.number().int().min(0).max(3).optional(),
        perIssueCapUsd: z.number().positive().optional(),
      })
      .strict()
      .optional(),
    route: z.enum(['codex', 'claude', 'opencode', 'command']).optional(),
    commands: z.record(z.string(), z.string()).optional().describe(EVIDENCE_COMMANDS_DESCRIPTION),
    ...ChecksConfigSections,
    ...PrConfigSections,
  })
  .strict();

// The `.describe()` text below is rendered into docs/config.example.yaml by
// renderConfigExample (./example.ts), so keep it accurate to the resolvers in this file.
export const RepoFactoryConfigV2Schema = z
  .object({
    $schema: z.string().optional().describe('Accepted and ignored.'),
    version: z.literal(2),
    models: z
      .object({
        registry: z
          .record(z.string(), ModelDefSchema.strict())
          .optional()
          .describe(
            'Repo-declared models: model id -> definition, same fields as a packaged model. Merged over the packaged registry before tiers and pins, so these ids can be pinned and placed in tiers. Ids must not reuse a packaged model id.',
          ),
        efforts: ModelEffortsSchema.optional(),
        pins: z
          .object({
            plan: z.string().optional().describe('PLAN model. Beats FACTORY_PLAN_MODEL.'),
            planFallback: z
              .string()
              .optional()
              .describe('PLAN model tried when the pinned plan model fails or its provider is tripped.'),
            build: z
              .string()
              .optional()
              .describe(
                'BUILD model. Beats FACTORY_BUILD_MODEL. When `route` is unset, its harness also picks the build route.',
              ),
            buildFallback: z.string().optional().describe('Codex-capable model to use after a Claude BUILD failure.'),
            checker: z.string().optional().describe('Checker model. Replaces the checker tier.'),
            triage: z.string().optional().describe('Triage model. Replaces the triage tier.'),
            classifier: z
              .string()
              .optional()
              .describe(
                'PR classifier model (classify_pr route). Unset: the checker tier. Changing it demotes the classifier (ADR-0121).',
              ),
          })
          .strict()
          .optional()
          .describe('Per-phase model pins. Each value is a model id from `factory models`. Unset: tier resolution.'),
        providerOrder: ProviderOrderOverrideSchema.optional().describe(PROVIDER_ORDER_DESCRIPTION),
      })
      .strict()
      .optional(),
    policy: z
      .object({ mode: z.enum(['pinned', 'auto']).optional() })
      .strict()
      .optional()
      .describe('Written by `factory migrate`. Not read at runtime.'),
    harnesses: RepoHarnessesSchema,
    tiers: z
      .record(z.string(), z.array(z.string()))
      .optional()
      .describe(
        'Tier name -> ordered model ids. Replaces that packaged tier; the router uses the first available model. ' +
          'An unknown model id fails loudly. The packaged tiers are:',
      ),
    providers: z
      .object({
        anthropic: z.boolean().optional(),
        openai: z.boolean().optional().describe('An explicit value beats the FACTORY_CODEX=0 kill-switch.'),
        ollama: z.boolean().optional(),
      })
      .strict()
      .optional()
      .describe('Provider switches. Unset leaves a provider on. `false` removes its models from every tier.'),
    budget: z
      .object({
        capUsd: z.number().positive().optional().describe('Run-wide usage cap in USD. Beats FACTORY_USAGE_CAP.'),
        fastPath: z.boolean().optional().describe('Trade expensive exploration for a bounded PLAN path.'),
        maxReworkRounds: z.number().int().min(0).max(3).optional().describe('Checker-rework retries per issue (0-3).'),
        perIssueCapUsd: z
          .number()
          .positive()
          .optional()
          .describe('Hard USD cap per issue, on top of the run-wide cap. Unset: no per-issue cap.'),
        laneBreakerThreshold: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Lane circuit breaker threshold (non-negative integer). 0 turns the breaker off. Unset: 2.'),
        /** Usage-watchdog knobs, colocated with `capUsd` since both gate the usage
         *  supervisor. Each field is independently optional so a repo can durably pin
         *  just one, e.g. `{"watchdog": {"pollSeconds": 60}}` (see resolveWatchdogPolicy). */
        watchdog: z
          .object({
            stopAt: z
              .number()
              .gt(0)
              .max(1)
              .optional()
              .describe('Usage fraction (0-1] at which work pauses. Beats FACTORY_STOP_AT.'),
            resumeAt: z
              .number()
              .gt(0)
              .max(1)
              .optional()
              .describe('Usage fraction (0-1] at which paused work resumes. Beats FACTORY_RESUME_AT.'),
            pollSeconds: z
              .number()
              .positive()
              .optional()
              .describe('Seconds between usage polls. Beats FACTORY_USAGE_POLL.'),
            watch: z.boolean().optional().describe('Enforce the usage gate. Beats FACTORY_USAGE_WATCH.'),
            estimator: z
              .boolean()
              .optional()
              .describe('Use the list-price usage estimator. Beats FACTORY_USAGE_ESTIMATOR.'),
          })
          .strict()
          .optional()
          .describe('Usage watchdog. `factory run` / `supervise` flags beat these values.'),
      })
      .strict()
      .optional(),
    classifier: z
      .object({
        alwaysHuman: z
          .array(z.string().min(1))
          .optional()
          .describe(
            'Path prefixes or globs forced to review class C. Added to the packaged C rules, never replacing them.',
          ),
        autoEligible: z
          .array(z.string().min(1))
          .optional()
          .describe(
            'Path prefixes or globs eligible for class A. Replaces the packaged A rules (docs/, *.md, *.test.ts).',
          ),
        maxDiffLines: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Total added+removed lines above which the floor is at least B.'),
        trustTier: z
          .enum(['T0', 'T1', 'T2'])
          .optional()
          .describe('Merge trust tier for this repo (ADR-0144). Unset: T0, a human merges every PR.'),
      })
      .strict()
      .optional()
      .describe('Review floor rules for the PR classifier. Unset keys use the packaged floor rules.'),
    ...HealthConfigSections,
    /** Repo pins the build route for every issue (e.g. "opencode", or "command" for a declared harness). The plan
     *  phase still writes the spec, but the pinned route wins over the model's
     *  route choice so deepseek workers are actually used when pinned. */
    route: z
      .enum(['codex', 'claude', 'opencode', 'command'])
      .optional()
      .describe(
        'Build route for every issue: "codex", "claude", "opencode", or "command" (a declared agentic harness under `harnesses`). ' +
          "Unset: derived from the build pin's harness, else PLAN decides per issue.",
      ),
    commands: z.record(z.string(), z.string()).optional().describe(EVIDENCE_COMMANDS_DESCRIPTION),
    ...ChecksConfigSections,
    ...PrConfigSections,
    ...OptionalConfigSections,
  })
  .strict();

type RepoFactoryConfigV1Input = z.input<typeof RepoFactoryConfigV1Schema>;
export type RepoFactoryConfig = z.infer<typeof RepoFactoryConfigV2Schema>;

export interface EfficiencyPolicy {
  fastPath: boolean;
  maxReworkRounds: number;
  perIssueCapUsd?: number;
}

/** Resolve bounded-work defaults: fast path is opt-in, and checker rework is capped at one retry by default. */
export function resolveEfficiencyPolicy(repo: RepoFactoryConfig | null): EfficiencyPolicy {
  return {
    fastPath: repo?.budget?.fastPath ?? false,
    maxReworkRounds: repo?.budget?.maxReworkRounds ?? 1,
    perIssueCapUsd: repo?.budget?.perIssueCapUsd,
  };
}

/** Resolve the lane breaker threshold: repo `budget.laneBreakerThreshold` > the packaged default (2). 0 means off. */
export function resolveLaneBreakerThreshold(repo: RepoFactoryConfig | null): number {
  return repo?.budget?.laneBreakerThreshold ?? defaultLaneBreakerThreshold;
}

// ---------- Loading ----------
/** The same file carries FactoryConfigSchema's runtime-policy namespace (see
 *  FACTORY_RUNTIME_CONFIG_KEYS). Drop those keys before the strict parse so they are not
 *  reported as typos, while genuine typos in the model namespace still fail loudly. */
function stripRuntimeKeys(raw: Record<string, unknown>): Record<string, unknown> {
  const out = { ...raw };
  for (const key of FACTORY_RUNTIME_CONFIG_KEYS) delete out[key];
  return out;
}

/** Convert the legacy repo-overlay shape to the canonical v2 in-memory shape.
 *  Empty optional sections stay omitted so adapted config has the same semantics
 *  as a minimal v2 file. */
export function adaptV1ToV2(v1: RepoFactoryConfigV1Input): RepoFactoryConfig {
  const pins = v1.models;
  const budget = {
    ...(v1.usage?.capUsd !== undefined ? { capUsd: v1.usage.capUsd } : {}),
    ...(v1.efficiency?.fastPath !== undefined ? { fastPath: v1.efficiency.fastPath } : {}),
    ...(v1.efficiency?.maxReworkRounds !== undefined ? { maxReworkRounds: v1.efficiency.maxReworkRounds } : {}),
    ...(v1.efficiency?.perIssueCapUsd !== undefined ? { perIssueCapUsd: v1.efficiency.perIssueCapUsd } : {}),
  };
  const hasPins = pins !== undefined && Object.keys(pins).length > 0;

  return {
    ...(v1.$schema !== undefined ? { $schema: v1.$schema } : {}),
    version: 2,
    ...(hasPins ? { models: { pins } } : {}),
    ...(hasPins ? { policy: { mode: 'pinned' as const } } : {}),
    ...(v1.tiers !== undefined ? { tiers: v1.tiers } : {}),
    ...(v1.providers !== undefined ? { providers: v1.providers } : {}),
    ...(Object.keys(budget).length > 0 ? { budget } : {}),
    ...(v1.route !== undefined ? { route: v1.route } : {}),
    ...(v1.commands !== undefined ? { commands: v1.commands } : {}),
    ...(v1.checks !== undefined ? { checks: v1.checks } : {}),
    ...(v1.pr !== undefined ? { pr: v1.pr } : {}),
  };
}

const warnedV1ConfigPaths = new Set<string>();

/** Schema issues for the model-routing keys of a parsed repo config file (V1 or V2 by `version`); `[]` when valid. Pure. */
export function repoRoutingConfigIssues(raw: unknown): ConfigSchemaIssue[] {
  const toParse = isPlainObject(raw) ? stripRuntimeKeys(raw) : raw;
  const result =
    isPlainObject(toParse) && toParse.version === 2
      ? RepoFactoryConfigV2Schema.safeParse(toParse)
      : RepoFactoryConfigV1Schema.safeParse(toParse);
  return result.success ? [] : toConfigSchemaIssues(result.error);
}

/** Read the resolved repo config file (`config.yaml|yml|json`). Returns `null` when the file
 *  does not exist. Throws a descriptive error naming the file path on malformed JSON/YAML or a
 *  schema violation (typos are rejected loudly via `.strict()` at every level). */
export function loadRepoConfig(repoRoot: string, stateRoot?: string): RepoFactoryConfig | null {
  const path = getFactoryPaths(repoRoot, stateRoot).config;
  const explicit = runConfigSource();
  if (explicit === undefined && !existsSync(path)) return null;

  let raw: unknown;
  if (explicit !== undefined) {
    try {
      raw = JSON.parse(explicit);
    } catch (err: any) {
      throw new Error(`Failed to parse ${path}: ${err.message}`, { cause: err });
    }
  } else {
    raw = readRepoConfigFile(path);
  }

  const toParse = isPlainObject(raw) ? stripRuntimeKeys(raw) : raw;
  const result =
    isPlainObject(toParse) && toParse.version === 2
      ? RepoFactoryConfigV2Schema.safeParse(toParse)
      : RepoFactoryConfigV1Schema.safeParse(toParse);
  if (!result.success) {
    const issues = toConfigSchemaIssues(result.error)
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid ${path}: ${issues}`);
  }
  if (result.data.version === 2) return result.data;

  if (!warnedV1ConfigPaths.has(path)) {
    console.warn(
      `factory: ${path} is v1 — loaded via the v1→v2 compatibility adapter; run \`factory migrate\` to rewrite it (v1 support is removed one release after v2)`,
    );
    warnedV1ConfigPaths.add(path);
  }
  return adaptV1ToV2(result.data);
}

// ---------- Applying to ModelsConfig ----------

/** Apply a repo config's model registry, tier overrides, harnesses, provider flags, and checker/triage pins to a
 *  packaged ModelsConfig, in that order. Pure; `null` repo is the identity transform (the critical no-config
 *  regression surface). Throws naming the tier/model on an unknown or `trainsOnPrompts` id (pin it instead), an
 *  emptied tier, a redefined packaged id, a redeclared harness, a registry `endpoint` that is not an approved
 *  Anthropic-compatible intermediary or lacks an envKey, or a registry model reaching DeepSeek directly (ADR-0163). */
export function applyRepoConfig(models: ModelsConfig, repo: RepoFactoryConfig | null): ModelsConfig {
  if (!repo) return models;

  const registry = repo.models?.registry ?? {};
  const { valid: validHarnesses, patch: harnessPatch } = resolveRepoHarnesses(models, repo.harnesses);
  for (const [id, def] of Object.entries(registry)) {
    if (Object.hasOwn(models.models, id)) {
      throw new Error(
        `.factory/config.json: models.registry.${id} redefines packaged model '${id}'; packaged model ids cannot be redefined. Register it under a new id (for example '${id}-custom') and pin or tier that id instead`,
      );
    }
    assertRegistryHarness(id, def.harness, validHarnesses);
    assertApprovedClaudeEndpoint(id, def);
    assertNoDirectDeepSeek(id, def);
  }
  const mergedModels = { ...models.models, ...registry };
  const knownModels = Object.keys(mergedModels).join(', ');
  let tiers: Record<string, string[]> = { ...models.tiers };

  if (repo.tiers) {
    for (const [tierName, modelIds] of Object.entries(repo.tiers)) {
      for (const id of modelIds) {
        if (!mergedModels[id]) {
          throw new Error(
            `.factory/config.json: tier '${tierName}' references unknown model '${id}' (known models: ${knownModels})${retiredModelHint(id)}`,
          );
        }
        assertTierMayRoute(tierName, id, mergedModels[id]);
      }
      tiers[tierName] = [...modelIds];
    }
  }

  if (repo.providers) {
    const disabledProviders = Object.entries(repo.providers)
      .filter(([, enabled]) => !enabled)
      .map(([provider]) => provider);
    if (disabledProviders.length > 0) {
      const nextTiers: Record<string, string[]> = {};
      for (const [tierName, modelIds] of Object.entries(tiers)) {
        nextTiers[tierName] = modelIds.filter((id) => !disabledProviders.includes(mergedModels[id]?.provider));
      }
      tiers = nextTiers;
    }
  }

  if (repo.models?.pins?.checker) {
    if (!mergedModels[repo.models.pins.checker]) {
      throw new Error(
        `.factory/config.json: models.pins.checker references unknown model '${repo.models.pins.checker}' (known models: ${knownModels})${retiredModelHint(repo.models.pins.checker)}`,
      );
    }
    tiers = { ...tiers, checker: [repo.models.pins.checker] };
  }
  if (repo.models?.pins?.triage) {
    if (!mergedModels[repo.models.pins.triage]) {
      throw new Error(
        `.factory/config.json: models.pins.triage references unknown model '${repo.models.pins.triage}' (known models: ${knownModels})${retiredModelHint(repo.models.pins.triage)}`,
      );
    }
    tiers = { ...tiers, triage: [repo.models.pins.triage] };
  }
  if (repo.models?.pins?.classifier && !mergedModels[repo.models.pins.classifier]) {
    throw new Error(
      `.factory/config.json: models.pins.classifier references unknown model '${repo.models.pins.classifier}' (known models: ${knownModels})${retiredModelHint(repo.models.pins.classifier)}`,
    );
  }

  for (const [tierName, modelIds] of Object.entries(tiers)) {
    const original = models.tiers[tierName];
    if (original && original.length > 0 && modelIds.length === 0) {
      throw new Error(
        `.factory/config.json: tier '${tierName}' has no models left after repo overrides (check 'providers' and 'tiers' settings)`,
      );
    }
  }

  // Only the roles the repo overrides need checking: the base order is the packaged one.
  const orderOverride = repo.models?.providerOrder;
  const orderIssues = providerOrderIssues({ ...orderOverride }, mergedModels);
  if (orderIssues.length > 0) {
    throw new Error(`.factory/config.json: ${orderIssues.map((i) => i.message).join('; ')}`);
  }
  const providerOrder = orderOverride
    ? { ...(models.providerOrder ?? deriveProviderOrder(models.tiers, models.models)), ...orderOverride }
    : models.providerOrder;

  return {
    ...models,
    models: mergedModels,
    tiers,
    ...(providerOrder ? { providerOrder } : {}),
    ...harnessPatch,
    ...(repo.models?.efforts ? { efforts: { ...models.efforts, ...repo.models.efforts } } : {}),
  };
}

// ---------- Effective plan/build pins ----------

export interface EffectiveModelPins {
  plan?: string;
  planFallback?: string;
  build?: string;
  buildFallback?: string;
  sources: { plan?: 'repo' | 'env'; planFallback?: 'repo'; build?: 'repo' | 'env'; buildFallback?: 'repo' };
}

/** Resolve plan/build model pins: repo file overrides env vars
 *  (FACTORY_PLAN_MODEL/FACTORY_BUILD_MODEL), which override no pin at all.
 *  `resolveModelOverrides` itself is untouched; this layers the repo file on top. */
export function resolveEffectiveModelPins(
  registry: ModelRegistry,
  repo: RepoFactoryConfig | null,
  env: NodeJS.ProcessEnv = process.env,
): EffectiveModelPins {
  const envOverrides = resolveModelOverrides(registry, env);
  const sources: EffectiveModelPins['sources'] = {};
  let plan = envOverrides.plan;
  if (plan) sources.plan = 'env';
  let build = envOverrides.build;
  if (build) sources.build = 'env';

  if (repo?.models?.pins?.plan) {
    if (!registry.get(repo.models.pins.plan)) {
      throw new Error(
        `.factory/config.json: models.pins.plan references unknown model '${repo.models.pins.plan}' (known models: ${registry.list().join(', ')})${retiredModelHint(repo.models.pins.plan)}`,
      );
    }
    plan = repo.models.pins.plan;
    sources.plan = 'repo';
  }
  let planFallback: string | undefined;
  if (repo?.models?.pins?.planFallback) {
    if (!registry.get(repo.models.pins.planFallback)) {
      throw new Error(
        `.factory/config.json: models.pins.planFallback references unknown model '${repo.models.pins.planFallback}' (known models: ${registry.list().join(', ')})${retiredModelHint(repo.models.pins.planFallback)}`,
      );
    }
    planFallback = repo.models.pins.planFallback;
    sources.planFallback = 'repo';
  }
  if (repo?.models?.pins?.build) {
    if (!registry.get(repo.models.pins.build)) {
      throw new Error(
        `.factory/config.json: models.pins.build references unknown model '${repo.models.pins.build}' (known models: ${registry.list().join(', ')})${retiredModelHint(repo.models.pins.build)}`,
      );
    }
    build = repo.models.pins.build;
    sources.build = 'repo';
  }
  if (build) assertAgenticBuildPin(registry, build, sources.build);
  let buildFallback: string | undefined;
  if (repo?.models?.pins?.buildFallback) {
    if (!registry.get(repo.models.pins.buildFallback)) {
      throw new Error(
        `.factory/config.json: models.pins.buildFallback references unknown model '${repo.models.pins.buildFallback}' (known models: ${registry.list().join(', ')})${retiredModelHint(repo.models.pins.buildFallback)}`,
      );
    }
    if (!registry.isCodexModel(repo.models.pins.buildFallback)) {
      throw new Error(
        `.factory/config.json: models.pins.buildFallback must be a Codex-capable model because it is used after Claude build failure`,
      );
    }
    assertAgenticBuildPin(registry, repo.models.pins.buildFallback, 'repo', 'buildFallback');
    buildFallback = repo.models.pins.buildFallback;
    sources.buildFallback = 'repo';
  }

  return {
    ...(plan ? { plan } : {}),
    ...(planFallback ? { planFallback } : {}),
    ...(build ? { build } : {}),
    ...(buildFallback ? { buildFallback } : {}),
    sources,
  };
}

// ---------- Effective build route ----------
/** Whether Codex/OpenAI routes should be disabled. Repo `providers.openai`, when
 *  explicitly set, wins; otherwise falls back to the FACTORY_CODEX=0 kill-switch. */
export function resolveCodexDisabled(repo: RepoFactoryConfig | null, env: NodeJS.ProcessEnv = process.env): boolean {
  if (repo?.providers?.openai !== undefined) {
    return !repo.providers.openai;
  }
  return env.FACTORY_CODEX === '0';
}

// ---------- Effective config (FACTORY_* env seam) ----------

/** The four model/routing env toggles resolved exactly once per run so the
 *  router, the phases, branch naming, and describeEffectiveConfig all agree
 *  within a single lane. Env precedence lives entirely in this record: repo
 *  `providers.openai` beats FACTORY_CODEX (via resolveCodexDisabled), and the
 *  three remaining values are plain FACTORY_* env reads with safe defaults. */
export interface EffectiveConfig {
  localOnly: boolean;
  allowExperimental: boolean;
  codexDisabled: boolean;
  branchPrefix: string;
}

export function resolveEffectiveConfig(
  repo: RepoFactoryConfig | null,
  env: NodeJS.ProcessEnv = process.env,
): EffectiveConfig {
  return {
    localOnly: resolveLocalOnly(env),
    allowExperimental: resolveExperimental(env),
    codexDisabled: resolveCodexDisabled(repo, env),
    branchPrefix: resolveBranchPrefix(),
  };
}

// ---------- Usage cap ----------

export interface EffectiveUsageCap {
  cap: number;
  source: 'repo' | 'env' | 'default';
}

/** Resolve the usage cap: repo `budget.capUsd` > `FACTORY_USAGE_CAP` env var > the
 *  packaged default (227). */
export function resolveUsageCap(
  repo: RepoFactoryConfig | null,
  env: NodeJS.ProcessEnv = process.env,
): EffectiveUsageCap {
  const { value, source } = resolvePrecedence<number, 'repo' | 'env'>(
    [
      { source: 'repo', read: () => repo?.budget?.capUsd },
      {
        source: 'env',
        read: () => {
          if (env.FACTORY_USAGE_CAP === undefined) return undefined;
          const cap = Number(env.FACTORY_USAGE_CAP);
          if (!Number.isFinite(cap) || cap <= 0) {
            throw new Error('FACTORY_USAGE_CAP must be a positive number');
          }
          return cap;
        },
      },
    ],
    227,
  );
  return { cap: value, source };
}

// ---------- Usage watchdog policy ----------

/** Where a resolved watchdog knob came from. `'flag'` is an explicit per-invocation CLI
 *  flag and outranks every other source. */
export type WatchdogPolicySource = ConfigSource;

/** Per-invocation CLI overrides. A field left `undefined` means "the flag was not
 *  supplied" and changes nothing; supplied values win over config file and env alike. */
export interface WatchdogPolicyOverrides {
  watch?: boolean;
  stopAt?: number;
  resumeAt?: number;
  pollSeconds?: number;
}

export interface EffectiveWatchdogPolicy {
  stopAt: number;
  resumeAt: number;
  pollMs: number;
  watch: boolean;
  estimator: boolean;
  sources: {
    stopAt: WatchdogPolicySource;
    resumeAt: WatchdogPolicySource;
    pollMs: WatchdogPolicySource;
    watch: WatchdogPolicySource;
    estimator: WatchdogPolicySource;
  };
}

/** Resolve the usage-watchdog knobs: repo `budget.watchdog.*` > the matching legacy
 *  `FACTORY_STOP_AT`/`FACTORY_RESUME_AT`/`FACTORY_USAGE_POLL`/`FACTORY_USAGE_WATCH`/
 *  `FACTORY_USAGE_ESTIMATOR` env var > the packaged default. Explicit per-invocation
 *  overrides have highest precedence. Each field resolves independently, mirroring
 *  `resolveUsageCap`. */
export function resolveWatchdogPolicy(
  repo: RepoFactoryConfig | null,
  env: NodeJS.ProcessEnv = process.env,
  overrides: WatchdogPolicyOverrides = {},
): EffectiveWatchdogPolicy {
  const wd = repo?.budget?.watchdog;

  const fraction = (value: number, message: string): number => {
    if (!Number.isFinite(value) || value <= 0 || value > 1) throw new Error(message);
    return value;
  };
  const positive = (value: number, message: string): number => {
    if (!Number.isFinite(value) || value <= 0) throw new Error(message);
    return value;
  };
  const envNumber = (raw: string | undefined, check: (n: number) => number): number | undefined =>
    raw === undefined ? undefined : check(Number(raw));

  const stopAt = resolvePrecedence<number>(
    [
      {
        source: 'flag',
        read: () =>
          overrides.stopAt === undefined
            ? undefined
            : fraction(overrides.stopAt, '--usage-threshold must be a number in (0, 1]'),
      },
      { source: 'repo', read: () => wd?.stopAt },
      {
        source: 'env',
        read: () => envNumber(env.FACTORY_STOP_AT, (n) => fraction(n, 'FACTORY_STOP_AT must be a number in (0, 1]')),
      },
    ],
    0.75,
  );
  const resumeAt = resolvePrecedence<number>(
    [
      {
        source: 'flag',
        read: () =>
          overrides.resumeAt === undefined
            ? undefined
            : fraction(overrides.resumeAt, '--usage-threshold must be a number in (0, 1]'),
      },
      { source: 'repo', read: () => wd?.resumeAt },
      {
        source: 'env',
        read: () =>
          envNumber(env.FACTORY_RESUME_AT, (n) => fraction(n, 'FACTORY_RESUME_AT must be a number in (0, 1]')),
      },
    ],
    0.65,
  );
  const pollSeconds = resolvePrecedence<number>(
    [
      {
        source: 'flag',
        read: () =>
          overrides.pollSeconds === undefined
            ? undefined
            : positive(overrides.pollSeconds, '--usage-poll must be a positive number'),
      },
      { source: 'repo', read: () => wd?.pollSeconds },
      {
        source: 'env',
        read: () =>
          envNumber(env.FACTORY_USAGE_POLL, (n) => positive(n, 'FACTORY_USAGE_POLL must be a positive number')),
      },
    ],
    180,
  );
  const watch = resolvePrecedence<boolean>(
    [
      { source: 'flag', read: () => overrides.watch },
      { source: 'repo', read: () => wd?.watch },
      {
        source: 'env',
        read: () => (env.FACTORY_USAGE_WATCH !== undefined ? env.FACTORY_USAGE_WATCH !== '0' : undefined),
      },
    ],
    true,
  );
  const estimator = resolvePrecedence<boolean>(
    [
      { source: 'repo', read: () => wd?.estimator },
      {
        source: 'env',
        read: () => (env.FACTORY_USAGE_ESTIMATOR !== undefined ? env.FACTORY_USAGE_ESTIMATOR === '1' : undefined),
      },
    ],
    false,
  );

  return {
    stopAt: stopAt.value,
    resumeAt: resumeAt.value,
    pollMs: pollSeconds.value * 1000,
    watch: watch.value,
    estimator: estimator.value,
    sources: {
      stopAt: stopAt.source,
      resumeAt: resumeAt.source,
      pollMs: pollSeconds.source,
      watch: watch.source,
      estimator: estimator.source,
    },
  };
}

// ---------- factory status formatter ----------

export interface DescribeEffectiveConfigOpts {
  router: ModelRouter;
  repo: RepoFactoryConfig | null;
  env?: NodeJS.ProcessEnv;
  /** Display label for the repo config file, e.g. '.factory/config.json'. */
  repoConfigPath: string;
  /** Merge auto/admin policy. `repo` here only carries the model-routing namespace
   *  (RepoFactoryConfig), not the FactoryConfig runtime-policy namespace `merge`/`run.merge`
   *  live in, so callers resolve this via `resolveMergePolicy` against their loaded
   *  FactoryConfig and pass it in. Omitting it falls back to an env-only policy (as if no
   *  repo file set merge/admin at all). */
  mergePolicy?: EffectiveMergePolicy;
  /** PR classifier gate (#1724), resolved via `resolvePrClassifierPolicy`. Omitted ⇒ env-only. */
  prClassifier?: EffectivePrClassifierPolicy;
}

function sourceLabel(
  source: ConfigSource | undefined,
  repoConfigPath: string,
  envVar: string,
  flagLabel?: string,
): string {
  if (source === 'flag') return flagLabel ? `(flag: ${flagLabel})` : '(flag)';
  if (source === 'repo') return `(${repoConfigPath})`;
  if (source === 'env') return `(env: ${envVar})`;
  return '(default)';
}

/** Pure formatter for `factory status`'s effective-config section: plan/build/
 *  checker/triage model + source, provider on/off + source, usage cap + source,
 *  and any tier-order overrides from the repo file. */
export function describeEffectiveConfig(opts: DescribeEffectiveConfigOpts): string[] {
  const { router, repo, repoConfigPath } = opts;
  const env = opts.env ?? process.env;
  const lines: string[] = [];

  const pins = resolveEffectiveModelPins(router.registryRef, repo, env);

  const planModel = pins.plan ?? router.resolve('plan') ?? 'none';
  lines.push(`Plan model: ${planModel} ${sourceLabel(pins.sources.plan, repoConfigPath, 'FACTORY_PLAN_MODEL')}`);
  if (pins.planFallback) lines.push(`Plan fallback: ${pins.planFallback} (${repoConfigPath})`);

  const buildModel = pins.build ?? router.resolve('build_claude') ?? 'none';
  lines.push(`Build model: ${buildModel} ${sourceLabel(pins.sources.build, repoConfigPath, 'FACTORY_BUILD_MODEL')}`);
  if (pins.buildFallback) lines.push(`Build fallback: ${pins.buildFallback} (${repoConfigPath})`);
  const buildRoute = resolveEffectiveBuildRoute(router.registryRef, repo, pins, {
    localOnly: resolveLocalOnly(env),
    codexDisabled: resolveCodexDisabled(repo, env),
  });
  const routeLabel = (): string => {
    switch (buildRoute.source) {
      case 'repo':
        return `(${repoConfigPath})`;
      case 'local-only':
        return buildRoute.note ? '(local-only, codex disabled)' : '(local-only)';
      case 'build-pin':
        return `(derived from build pin ${pins.build})`;
      case 'plan':
        return buildRoute.note ? `(${buildRoute.note})` : '(default)';
    }
  };
  lines.push(`Build route: ${buildRoute.route ?? 'plan decides'} ${routeLabel()}`);

  const checkerModel = repo?.models?.pins?.checker ?? router.resolve('check_tests') ?? 'none';
  lines.push(
    `Checker model: ${checkerModel} ${sourceLabel(repo?.models?.pins?.checker ? 'repo' : 'default', repoConfigPath, '')}`,
  );

  const triageModel = repo?.models?.pins?.triage ?? router.resolve('triage') ?? 'none';
  lines.push(
    `Triage model: ${triageModel} ${sourceLabel(repo?.models?.pins?.triage ? 'repo' : 'default', repoConfigPath, '')}`,
  );

  for (const [model, effort] of Object.entries(repo?.models?.efforts ?? {})) {
    lines.push(`Effort ${model}: ${JSON.stringify(effort)} (${repoConfigPath})`);
  }

  const codexOff = resolveCodexDisabled(repo, env);
  const openaiSource: 'repo' | 'env' | 'default' =
    repo?.providers?.openai !== undefined ? 'repo' : env.FACTORY_CODEX === '0' ? 'env' : 'default';
  lines.push(
    `Provider anthropic: ${repo?.providers?.anthropic === false ? 'off' : 'on'} ${sourceLabel(repo?.providers?.anthropic !== undefined ? 'repo' : 'default', repoConfigPath, '')}`,
  );
  lines.push(
    `Provider openai: ${codexOff ? 'off' : 'on'} ${sourceLabel(openaiSource, repoConfigPath, 'FACTORY_CODEX')}`,
  );
  lines.push(
    `Provider ollama: ${repo?.providers?.ollama === false ? 'off' : 'on'} ${sourceLabel(repo?.providers?.ollama !== undefined ? 'repo' : 'default', repoConfigPath, '')}`,
  );

  const effective = resolveEffectiveConfig(repo, env);
  lines.push(
    `Local only: ${effective.localOnly ? 'on' : 'off'} ${sourceLabel(env.FACTORY_LOCAL_ONLY !== undefined ? 'env' : 'default', repoConfigPath, 'FACTORY_LOCAL_ONLY')}`,
  );
  lines.push(
    `Experimental models: ${effective.allowExperimental ? 'on' : 'off'} ${sourceLabel(env.FACTORY_EXPERIMENTAL !== undefined ? 'env' : 'default', repoConfigPath, 'FACTORY_EXPERIMENTAL')}`,
  );
  lines.push(`Branch prefix: ${effective.branchPrefix} ${sourceLabel('default', repoConfigPath, '')}`);

  const usage = resolveUsageCap(repo, env);
  lines.push(`Usage cap: $${usage.cap} ${sourceLabel(usage.source, repoConfigPath, 'FACTORY_USAGE_CAP')}`);

  const mergePolicy = opts.mergePolicy ?? resolveMergePolicy(loadFactoryConfig(), env);
  lines.push(
    `Merge auto: ${mergePolicy.auto ? 'on' : 'off'} ${sourceLabel(
      mergePolicy.sources.auto,
      repoConfigPath,
      'FACTORY_MERGE',
      mergePolicy.auto ? '--auto-merge' : '--no-auto-merge',
    )}`,
  );
  lines.push(
    `Merge admin: ${mergePolicy.admin ? 'on' : 'off'} ${sourceLabel(mergePolicy.sources.admin, repoConfigPath, 'FACTORY_MERGE_ADMIN')}`,
  );
  const prClassifier: EffectivePrClassifierPolicy =
    opts.prClassifier ?? resolvePrClassifierPolicy(loadFactoryConfig(), env);
  lines.push(
    `PR classifier: ${prClassifier.enabled ? 'on' : 'off'} ${sourceLabel(
      prClassifier.source,
      repoConfigPath,
      'FACTORY_PR_CLASSIFIER',
      prClassifier.enabled ? '--pr-classifier' : '--no-pr-classifier',
    )}`,
  );

  const watchdog = resolveWatchdogPolicy(repo, env);
  lines.push(
    `Usage watchdog stop-at: ${watchdog.stopAt} ${sourceLabel(watchdog.sources.stopAt, repoConfigPath, 'FACTORY_STOP_AT')}`,
  );
  lines.push(
    `Usage watchdog resume-at: ${watchdog.resumeAt} ${sourceLabel(watchdog.sources.resumeAt, repoConfigPath, 'FACTORY_RESUME_AT')}`,
  );
  lines.push(
    `Usage watchdog poll: ${watchdog.pollMs / 1000}s ${sourceLabel(watchdog.sources.pollMs, repoConfigPath, 'FACTORY_USAGE_POLL')}`,
  );
  lines.push(
    `Usage watchdog watch: ${watchdog.watch ? 'on' : 'off'} ${sourceLabel(watchdog.sources.watch, repoConfigPath, 'FACTORY_USAGE_WATCH')}`,
  );
  lines.push(
    `Usage watchdog estimator: ${watchdog.estimator ? 'on' : 'off'} ${sourceLabel(watchdog.sources.estimator, repoConfigPath, 'FACTORY_USAGE_ESTIMATOR')}`,
  );

  if (repo?.tiers) {
    for (const [tier, ids] of Object.entries(repo.tiers)) {
      lines.push(`Tier override ${tier}: ${ids.join(' ')} (${repoConfigPath})`);
    }
  }

  return lines;
}

/** Review floor rules for this repo: the classifier section merged onto the packaged rules (#1723). */
export function resolveReviewFloorRules(repo: RepoFactoryConfig | null): ReviewFloorRuleSet {
  return applyReviewFloorOverrides(repo?.classifier);
}

export type TrustTier = 'T0' | 'T1' | 'T2';

/** Effective merge trust tier for this repo (ADR-0144, #2131): classifier.trustTier, else T0. */
export function resolveTrustTier(repo: RepoFactoryConfig | null): TrustTier {
  return repo?.classifier?.trustTier ?? 'T0';
}

export { decideBuildRoute, resolveEffectiveBuildRoute, routeForBuildModel } from './build-route.js';
export type { BuildRouteDecisionInput, BuildRoutePin, EffectiveBuildRoute } from './build-route.js';
