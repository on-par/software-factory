// src/config/repo.ts — Per-repo model/runtime config overrides (.factory/config.json)
//
// Lets a consuming repo commit its own model policy (per-phase pins, tier order,
// provider enable flags, usage cap) without editing the packaged defaults shipped
// in @on-par/factory-config. Resolution order: repo file > env vars > packaged
// defaults.

import { existsSync, readFileSync } from 'node:fs';

import { z } from 'zod';

import type { ModelRegistry } from '../models/index.js';
import { resolveModelOverrides } from '../models/index.js';
import type { ModelRouter } from '../router/index.js';
import {
  FACTORY_RUNTIME_CONFIG_KEYS,
  getFactoryPaths,
  isPlainObject,
  resolveBranchPrefix,
  resolveExperimental,
  resolveLocalOnly,
  type ModelsConfig,
} from './index.js';

// ---------- Schema ----------

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
    /** Repo pins the build route for every issue (e.g. "opencode"). The plan
     *  phase still writes the spec, but the pinned route wins over the model's
     *  route choice so deepseek workers are actually used when pinned. */
    route: z.enum(['codex', 'claude', 'opencode']).optional(),
  })
  .strict();

export const RepoFactoryConfigV2Schema = z
  .object({
    $schema: z.string().optional(),
    version: z.literal(2),
    models: z
      .object({
        pins: z
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
      })
      .strict()
      .optional(),
    policy: z
      .object({ mode: z.enum(['pinned', 'auto']).optional() })
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
    budget: z
      .object({
        capUsd: z.number().positive().optional(),
        fastPath: z.boolean().optional(),
        maxReworkRounds: z.number().int().min(0).max(3).optional(),
        perIssueCapUsd: z.number().positive().optional(),
      })
      .strict()
      .optional(),
    /** Repo pins the build route for every issue (e.g. "opencode"). The plan
     *  phase still writes the spec, but the pinned route wins over the model's
     *  route choice so deepseek workers are actually used when pinned. */
    route: z.enum(['codex', 'claude', 'opencode']).optional(),
  })
  .strict();

type RepoFactoryConfigV1Input = z.input<typeof RepoFactoryConfigV1Schema>;
export type RepoFactoryConfig = z.infer<typeof RepoFactoryConfigV2Schema>;

export interface EfficiencyPolicy {
  fastPath: boolean;
  maxReworkRounds: number;
  perIssueCapUsd?: number;
}

/** Resolve bounded-work defaults. Fast path remains opt-in so existing repos retain
 * their PLAN behavior, while checker rework is capped at one retry by default. */
export function resolveEfficiencyPolicy(repo: RepoFactoryConfig | null): EfficiencyPolicy {
  return {
    fastPath: repo?.budget?.fastPath ?? false,
    maxReworkRounds: repo?.budget?.maxReworkRounds ?? 1,
    perIssueCapUsd: repo?.budget?.perIssueCapUsd,
  };
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
  };
}

const warnedV1ConfigPaths = new Set<string>();

/** Read the resolved factory-state `config.json`. Returns `null` when the file does
 *  not exist. Throws a descriptive error naming the file path on malformed JSON or a
 *  schema violation (typos are rejected loudly via `.strict()` at every level). */
export function loadRepoConfig(repoRoot: string, stateRoot?: string): RepoFactoryConfig | null {
  const path = getFactoryPaths(repoRoot, stateRoot).config;
  if (!existsSync(path)) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err: any) {
    throw new Error(`Failed to parse ${path}: ${err.message}`);
  }

  const toParse = isPlainObject(raw) ? stripRuntimeKeys(raw) : raw;
  const result =
    isPlainObject(toParse) && toParse.version === 2
      ? RepoFactoryConfigV2Schema.safeParse(toParse)
      : RepoFactoryConfigV1Schema.safeParse(toParse);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
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

/** Apply a repo config's tier overrides, provider flags, and checker/triage pins
 *  to a packaged ModelsConfig. Pure — returns a new ModelsConfig; `null` repo is
 *  the identity transform (the critical no-`.factory/config.json` regression
 *  surface). Throws naming the offending tier/model on an unknown model id, or
 *  naming the tier emptied by provider/tier settings. */
export function applyRepoConfig(models: ModelsConfig, repo: RepoFactoryConfig | null): ModelsConfig {
  if (!repo) return models;

  const knownModels = Object.keys(models.models).join(', ');
  let tiers: Record<string, string[]> = { ...models.tiers };

  if (repo.tiers) {
    for (const [tierName, modelIds] of Object.entries(repo.tiers)) {
      for (const id of modelIds) {
        if (!models.models[id]) {
          throw new Error(
            `.factory/config.json: tier '${tierName}' references unknown model '${id}' (known models: ${knownModels})`,
          );
        }
      }
      tiers[tierName] = [...modelIds];
    }
  }

  if (repo.providers) {
    const disabledProviders = Object.entries(repo.providers)
      .filter(([, enabled]) => enabled === false)
      .map(([provider]) => provider);
    if (disabledProviders.length > 0) {
      const nextTiers: Record<string, string[]> = {};
      for (const [tierName, modelIds] of Object.entries(tiers)) {
        nextTiers[tierName] = modelIds.filter((id) => !disabledProviders.includes(models.models[id]?.provider));
      }
      tiers = nextTiers;
    }
  }

  if (repo.models?.pins?.checker) {
    if (!models.models[repo.models.pins.checker]) {
      throw new Error(
        `.factory/config.json: models.pins.checker references unknown model '${repo.models.pins.checker}' (known models: ${knownModels})`,
      );
    }
    tiers = { ...tiers, checker: [repo.models.pins.checker] };
  }
  if (repo.models?.pins?.triage) {
    if (!models.models[repo.models.pins.triage]) {
      throw new Error(
        `.factory/config.json: models.pins.triage references unknown model '${repo.models.pins.triage}' (known models: ${knownModels})`,
      );
    }
    tiers = { ...tiers, triage: [repo.models.pins.triage] };
  }

  for (const [tierName, modelIds] of Object.entries(tiers)) {
    const original = models.tiers[tierName];
    if (original && original.length > 0 && modelIds.length === 0) {
      throw new Error(
        `.factory/config.json: tier '${tierName}' has no models left after repo overrides (check 'providers' and 'tiers' settings)`,
      );
    }
  }

  return { ...models, tiers };
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
        `.factory/config.json: models.pins.plan references unknown model '${repo.models.pins.plan}' (known models: ${registry.list().join(', ')})`,
      );
    }
    plan = repo.models.pins.plan;
    sources.plan = 'repo';
  }
  let planFallback: string | undefined;
  if (repo?.models?.pins?.planFallback) {
    if (!registry.get(repo.models.pins.planFallback)) {
      throw new Error(
        `.factory/config.json: models.pins.planFallback references unknown model '${repo.models.pins.planFallback}' (known models: ${registry.list().join(', ')})`,
      );
    }
    planFallback = repo.models.pins.planFallback;
    sources.planFallback = 'repo';
  }
  if (repo?.models?.pins?.build) {
    if (!registry.get(repo.models.pins.build)) {
      throw new Error(
        `.factory/config.json: models.pins.build references unknown model '${repo.models.pins.build}' (known models: ${registry.list().join(', ')})`,
      );
    }
    build = repo.models.pins.build;
    sources.build = 'repo';
  }
  let buildFallback: string | undefined;
  if (repo?.models?.pins?.buildFallback) {
    if (!registry.get(repo.models.pins.buildFallback)) {
      throw new Error(
        `.factory/config.json: models.pins.buildFallback references unknown model '${repo.models.pins.buildFallback}' (known models: ${registry.list().join(', ')})`,
      );
    }
    if (!registry.isCodexModel(repo.models.pins.buildFallback)) {
      throw new Error(
        `.factory/config.json: models.pins.buildFallback must be a Codex-capable model because it is used after Claude build failure`,
      );
    }
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

// ---------- Codex kill-switch ----------

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
    branchPrefix: resolveBranchPrefix(env),
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
  if (repo?.budget?.capUsd !== undefined) {
    return { cap: repo.budget.capUsd, source: 'repo' };
  }
  if (env.FACTORY_USAGE_CAP !== undefined) {
    const cap = Number(env.FACTORY_USAGE_CAP);
    if (!Number.isFinite(cap) || cap <= 0) {
      throw new Error('FACTORY_USAGE_CAP must be a positive number');
    }
    return { cap, source: 'env' };
  }
  return { cap: 227, source: 'default' };
}

// ---------- factory status formatter ----------

export interface DescribeEffectiveConfigOpts {
  router: ModelRouter;
  repo: RepoFactoryConfig | null;
  env?: NodeJS.ProcessEnv;
  /** Display label for the repo config file, e.g. '.factory/config.json'. */
  repoConfigPath: string;
}

function sourceLabel(source: 'repo' | 'env' | 'default' | undefined, repoConfigPath: string, envVar: string): string {
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

  const checkerModel = repo?.models?.pins?.checker ?? router.resolve('check_tests') ?? 'none';
  lines.push(
    `Checker model: ${checkerModel} ${sourceLabel(repo?.models?.pins?.checker ? 'repo' : 'default', repoConfigPath, '')}`,
  );

  const triageModel = repo?.models?.pins?.triage ?? router.resolve('triage') ?? 'none';
  lines.push(
    `Triage model: ${triageModel} ${sourceLabel(repo?.models?.pins?.triage ? 'repo' : 'default', repoConfigPath, '')}`,
  );

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
  lines.push(
    `Branch prefix: ${effective.branchPrefix} ${sourceLabel(env.FACTORY_BRANCH_PREFIX !== undefined ? 'env' : 'default', repoConfigPath, 'FACTORY_BRANCH_PREFIX')}`,
  );

  const usage = resolveUsageCap(repo, env);
  lines.push(`Usage cap: $${usage.cap} ${sourceLabel(usage.source, repoConfigPath, 'FACTORY_USAGE_CAP')}`);

  if (repo?.tiers) {
    for (const [tier, ids] of Object.entries(repo.tiers)) {
      lines.push(`Tier override ${tier}: ${ids.join(' ')} (${repoConfigPath})`);
    }
  }

  return lines;
}
