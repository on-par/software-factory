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
import { getFactoryPaths, type ModelsConfig } from './index.js';

// ---------- Schema ----------

const RepoFactoryConfigSchema = z
  .object({
    version: z.literal(1).default(1),
    models: z
      .object({
        plan: z.string().optional(),
        build: z.string().optional(),
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
  })
  .strict();

export type RepoFactoryConfig = z.infer<typeof RepoFactoryConfigSchema>;

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
  build?: string;
  sources: { plan?: 'repo' | 'env'; build?: 'repo' | 'env' };
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
  if (repo?.models?.build) {
    if (!registry.get(repo.models.build)) {
      throw new Error(
        `.factory/config.json: models.build references unknown model '${repo.models.build}' (known models: ${registry.list().join(', ')})`,
      );
    }
    build = repo.models.build;
    sources.build = 'repo';
  }

  return { plan, build, sources };
}

// ---------- Codex kill-switch ----------

/** Whether Codex/OpenAI routes should be disabled. Repo `providers.openai`, when
 *  explicitly set, wins; otherwise falls back to the FACTORY_CODEX=0 kill-switch
 *  (mirroring `codexDisabled()` in utils/index.ts). */
export function resolveCodexDisabled(repo: RepoFactoryConfig | null, env: NodeJS.ProcessEnv = process.env): boolean {
  if (repo?.providers?.openai !== undefined) {
    return !repo.providers.openai;
  }
  return env.FACTORY_CODEX === '0';
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

  const buildModel = pins.build ?? router.resolve('build_claude') ?? 'none';
  lines.push(`Build model: ${buildModel} ${sourceLabel(pins.sources.build, repoConfigPath, 'FACTORY_BUILD_MODEL')}`);

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

  const usage = resolveUsageCap(repo, env);
  lines.push(`Usage cap: $${usage.cap} ${sourceLabel(usage.source, repoConfigPath, 'FACTORY_USAGE_CAP')}`);

  if (repo?.tiers) {
    for (const [tier, ids] of Object.entries(repo.tiers)) {
      lines.push(`Tier override ${tier}: ${ids.join(' ')} (${repoConfigPath})`);
    }
  }

  return lines;
}
