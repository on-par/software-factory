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
  getFactoryPaths,
  resolveBranchPrefix,
  resolveExperimental,
  resolveLocalOnly,
  type ModelsConfig,
} from './index.js';
import { parseConfigV2 } from './v2.js';

// ---------- Schema ----------

const RepoFactoryConfigSchema = z
  .object({
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

export type RepoFactoryConfig = z.infer<typeof RepoFactoryConfigSchema>;

export interface EfficiencyPolicy {
  fastPath: boolean;
  maxReworkRounds: number;
  perIssueCapUsd?: number;
}

/** Resolve bounded-work defaults. Fast path remains opt-in so existing repos retain
 * their PLAN behavior, while checker rework is capped at one retry by default. */
export function resolveEfficiencyPolicy(repo: RepoFactoryConfig | null): EfficiencyPolicy {
  return {
    fastPath: repo?.efficiency?.fastPath ?? false,
    maxReworkRounds: repo?.efficiency?.maxReworkRounds ?? 1,
    perIssueCapUsd: repo?.efficiency?.perIssueCapUsd,
  };
}

// ---------- Loading ----------

/** Read `<repoRoot>/.factory/config.json`. Returns `null` when the file does not
 *  exist. Throws a descriptive error naming the file path on malformed JSON or a
 *  schema violation (typos are rejected loudly via `.strict()` at every level). */
export function loadRepoConfig(repoRoot: string): RepoFactoryConfig | null {
  const path = getFactoryPaths(repoRoot).config;
  if (!existsSync(path)) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err: any) {
    throw new Error(`Failed to parse ${path}: ${err.message}`);
  }

  if (typeof raw === 'object' && raw !== null && (raw as { version?: unknown }).version === 2) {
    // v2 files are validated loudly but not yet consumed here — the v2→v1
    // in-memory adapter is a separate issue. Null = "no v1 repo overrides".
    parseConfigV2(raw, path);
    return null;
  }

  const result = RepoFactoryConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new Error(`Invalid ${path}: ${issues}`);
  }
  return result.data;
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

  if (repo.models?.checker) {
    if (!models.models[repo.models.checker]) {
      throw new Error(
        `.factory/config.json: models.checker references unknown model '${repo.models.checker}' (known models: ${knownModels})`,
      );
    }
    tiers = { ...tiers, checker: [repo.models.checker] };
  }
  if (repo.models?.triage) {
    if (!models.models[repo.models.triage]) {
      throw new Error(
        `.factory/config.json: models.triage references unknown model '${repo.models.triage}' (known models: ${knownModels})`,
      );
    }
    tiers = { ...tiers, triage: [repo.models.triage] };
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

  if (repo?.models?.plan) {
    if (!registry.get(repo.models.plan)) {
      throw new Error(
        `.factory/config.json: models.plan references unknown model '${repo.models.plan}' (known models: ${registry.list().join(', ')})`,
      );
    }
    plan = repo.models.plan;
    sources.plan = 'repo';
  }
  let planFallback: string | undefined;
  if (repo?.models?.planFallback) {
    if (!registry.get(repo.models.planFallback)) {
      throw new Error(
        `.factory/config.json: models.planFallback references unknown model '${repo.models.planFallback}' (known models: ${registry.list().join(', ')})`,
      );
    }
    planFallback = repo.models.planFallback;
    sources.planFallback = 'repo';
  }
  if (repo?.models?.build) {
    if (!registry.get(repo.models.build)) {
      throw new Error(
        `.factory/config.json: models.build references unknown model '${repo.models.build}' (known models: ${registry.list().join(', ')})`,
      );
    }
    build = repo.models.build;
    sources.build = 'repo';
  }
  let buildFallback: string | undefined;
  if (repo?.models?.buildFallback) {
    if (!registry.get(repo.models.buildFallback)) {
      throw new Error(
        `.factory/config.json: models.buildFallback references unknown model '${repo.models.buildFallback}' (known models: ${registry.list().join(', ')})`,
      );
    }
    if (!registry.isCodexModel(repo.models.buildFallback)) {
      throw new Error(
        `.factory/config.json: models.buildFallback must be a Codex-capable model because it is used after Claude build failure`,
      );
    }
    buildFallback = repo.models.buildFallback;
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

/** Resolve the usage cap: repo `usage.capUsd` > `FACTORY_USAGE_CAP` env var > the
 *  packaged default (227). */
export function resolveUsageCap(
  repo: RepoFactoryConfig | null,
  env: NodeJS.ProcessEnv = process.env,
): EffectiveUsageCap {
  if (repo?.usage?.capUsd !== undefined) {
    return { cap: repo.usage.capUsd, source: 'repo' };
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

  const checkerModel = repo?.models?.checker ?? router.resolve('check_tests') ?? 'none';
  lines.push(
    `Checker model: ${checkerModel} ${sourceLabel(repo?.models?.checker ? 'repo' : 'default', repoConfigPath, '')}`,
  );

  const triageModel = repo?.models?.triage ?? router.resolve('triage') ?? 'none';
  lines.push(
    `Triage model: ${triageModel} ${sourceLabel(repo?.models?.triage ? 'repo' : 'default', repoConfigPath, '')}`,
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
