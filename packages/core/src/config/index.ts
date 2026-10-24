// packages/core/src/config/index.ts — Configuration loaders with Zod validation
//
// The shipped defaults live in @on-par/factory-config (a separate workspace
// package that ships typed TS defaults + constitution markdown). This module
// validates those defaults when called with no path, or reads and validates
// an explicit JSON file path.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  defaultFactoryConfig,
  defaultModelsConfig,
  defaultRoutesConfig,
  resolveConfigPath,
} from '@on-par/factory-config';
import { z } from 'zod';
import { failoverConfigWarnings, FailoverTriggersSchema } from './failover-triggers.js';
import { readRepoConfigFile, resolveRepoConfigPath } from './repo-config-file.js';
import { resolveStateRoot, STATE_ROOT_ENV } from './state-root.js';
import { DEFAULT_MAX_SLICES, SLICE_CAP_CEILING } from '../readiness/slice-plan.js';
import { DEFAULT_MAX_FILES, DEFAULT_TOKEN_BUDGET, type SizeBudget } from '../readiness/size.js';
import { isOpenCodeZenModel } from './provider-order.js';
import { DEFAULT_CI_DEADLINE_MS } from '../utils/ci-deadline.js';
import { EventsConfigSchema } from '../events/rotation.js';
import { runConfigSource } from './run-config-source.js';
import { RunConfigSectionSchema } from './run-section.js';
import { PrConfigSections } from './pr-section.js';
import { FACTORY_RUNTIME_CONFIG_KEYS } from './runtime-config-keys.js';

import type { FilingPolicy } from '../filing/policy.js';
import { builtInHarnessRedeclaredMessage, KNOWN_HARNESS_IDS, retiredHarnessReplacement } from '../harness/catalog.js';
import type { FailoverReason } from '../types/index.js';
import { SandboxConfigSchema } from './sandbox-schema.js';
import { ModelEffortsSchema } from './effort.js';
import { resolvePrecedence, type ConfigSource } from './precedence.js';
import { HarnessDeclarationSchema, type HarnessDeclaration } from './harness-declaration.js';

export {
  HARNESS_ERROR_PATTERN_REASONS,
  HARNESS_OUTPUT_MODES,
  HARNESS_PROMPT_MODES,
  HARNESS_USAGE_MODES,
  HarnessDeclarationSchema,
  type HarnessDeclaration,
} from './harness-declaration.js';

// ---------- Schemas ----------

export const ModelDefSchema = z.object({
  provider: z.enum(['anthropic', 'openai', 'ollama', 'deepseek', 'custom']),
  tier: z.union([z.string(), z.array(z.string())]),
  costPerMtokInput: z.number(),
  costPerMtokOutput: z.number(),
  costPerMtokCachedInput: z.number().optional(),
  contextWindow: z.number(),
  capabilities: z.array(z.string()),
  envKey: z.string().nullable(),
  claudeFlag: z.string().optional(),
  providerModel: z.string().optional(),
  providerOptions: z.record(z.string(), z.unknown()).optional(),
  endpoint: z.string().optional(),
  codex: z.boolean().optional(),
  codexFlag: z.string().optional(),
  harness: z.string().optional(),
  experimental: z.boolean().optional(),
  trainsOnPrompts: z.boolean().optional(),
});

const ModelsConfigSchema = z
  .object({
    version: z.number(),
    models: z.record(z.string(), ModelDefSchema),
    efforts: ModelEffortsSchema.optional(),
    tiers: z.record(z.string(), z.array(z.string())),
    providerOrder: z.record(z.string(), z.array(z.string())).optional(),
    failover: z.object({
      triggers: FailoverTriggersSchema,
      maxRetries: z.number(),
      cooldownMs: z.number(),
    }),
    routingRules: z.record(z.string(), z.unknown()).default({}),
    harnesses: z.record(z.string(), HarnessDeclarationSchema).default({}),
  })
  .superRefine((config, ctx) => {
    const declared = Object.keys(config.harnesses);
    for (const id of declared) {
      if (KNOWN_HARNESS_IDS.includes(id) || retiredHarnessReplacement(id) !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['harnesses', id],
          message: builtInHarnessRedeclaredMessage(id),
        });
      }
    }
    const valid = [...KNOWN_HARNESS_IDS, ...declared.filter((id) => !KNOWN_HARNESS_IDS.includes(id))];
    for (const [name, def] of Object.entries(config.models)) {
      if (
        def.harness !== undefined &&
        !valid.includes(def.harness) &&
        retiredHarnessReplacement(def.harness) === undefined
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['models', name, 'harness'],
          message: `Model '${name}' declares unknown harness '${def.harness}' (valid harnesses: ${valid.join(', ')}; declare custom ones under 'harnesses')`,
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
      model: z.string().optional(),
      allowedTools: z.array(z.string()).optional(),
      output: z.literal('json').optional(),
    }),
  ),
});

export const FactoryConfigSchema = z.object({
  version: z.number(),
  paths: z.object({
    constitutions: z.string(),
    checkers: z.string(),
    plans: z.string(),
    logs: z.string(),
    events: z.string(),
    constitution: z.string().default('.factory/constitution.md'),
  }),
  timeouts: z.object({
    plan_seconds: z.number(),
    build_seconds: z.number(),
    check_seconds: z.number(),
    merge_poll_seconds: z.number(),
    approval_seconds: z.number().default(1800),
    tests_seconds: z.number().default(300),
    compile_seconds: z.number().default(120),
  }),
  merge: z.object({ auto: z.boolean(), admin: z.boolean().default(false), comment: z.string() }),
  /** `run.merge.*` mirrors FactoryConfigV2Schema's `run.merge` naming and, when present,
   *  is authoritative over the legacy top-level `merge.*` fields above (see
   *  `resolveMergePolicy`). Left optional with no defaults so "unset" survives parsing
   *  and is distinguishable from an explicit `false`. */
  run: RunConfigSectionSchema,
  ...PrConfigSections,
  worktree: z.object({
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
      watchMinutes: z.number().optional().catch(undefined),
      awaitingCiCapHours: z.number().optional().catch(undefined),
      comment: z.string().default('Set FACTORY_SKIP_CI=1 to skip waiting for GitHub Actions CI before merging'),
    })
    .default({ skip: false, comment: 'Set FACTORY_SKIP_CI=1 to skip waiting for GitHub Actions CI before merging' }),
  sweep: z
    .object({
      heartbeatFile: z.string().optional(),
      loopIntervalSeconds: z.number().int().positive().default(300),
      staleThresholdMultiplier: z.number().positive().default(2),
      comment: z.string().optional(),
    })
    .default({ loopIntervalSeconds: 300, staleThresholdMultiplier: 2 }),
  plan_approval: z
    .object({ enabled: z.boolean().default(false), comment: z.string().optional() })
    .default({ enabled: false }),
  design: z
    .object({ blockUnresolvedRegressions: z.boolean().default(false) })
    .default({ blockUnresolvedRegressions: false }),
  readiness: z.object({ updateIssueBody: z.boolean().default(true) }).default({ updateIssueBody: true }),
  build: z
    .object({
      publishFromBuild: z.boolean().default(false),
      contextCeiling: z.record(z.string(), z.number().int().nonnegative()).default({ 'codex-cli': 120000 }),
    })
    .default({ publishFromBuild: false, contextCeiling: { 'codex-cli': 120000 } }),
  // Plain string on purpose: an unknown mode must load and resolve to `file`, not throw.
  sizeGate: z
    .object({
      mode: z.string().default('file'),
      maxSlices: z.number().int().min(1).max(SLICE_CAP_CEILING).optional(),
      tokenBudget: z.number().int().positive().optional(),
      maxFiles: z.number().int().positive().optional(),
    })
    .default({ mode: 'file' }),
  kpis: z
    .object({ defectWindowDays: z.number().int().positive().default(14), comment: z.string().optional() })
    .default({ defectWindowDays: 14 }),
  events: EventsConfigSchema,
  sandbox: SandboxConfigSchema,
  discovery: z
    .object({
      enabled: z.boolean().default(true),
      schedule: z.enum(['weekly', 'daily', 'manual']).default('weekly'),
      maxCandidates: z.number().int().positive().default(5),
      comment: z.string().optional(),
    })
    .default({ enabled: true, schedule: 'weekly', maxCandidates: 5 }),
  filing: z
    .object({
      enabled: z.boolean().default(true),
      excludeReasons: z.array(z.string()).default(['rate_limit', 'usage_cap', 'timeout', 'verify_failed']),
      repeatThreshold: z.number().int().positive().default(3),
      maxPerRun: z.number().int().positive().default(5),
      maxPerDay: z.number().int().positive().default(20),
      selfFixLabel: z.string().default('no-auto-merge'),
      bugLabels: z.array(z.string()).default(['bug']),
      repo: z
        .string()
        .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'filing.repo must be owner/name')
        .optional(),
      sensitivePaths: z
        .array(z.string())
        .default(['packages/core/', 'packages/config/', 'packages/cli/', 'scripts/', '.github/']),
      comment: z.string().optional(),
    })
    .default({
      enabled: true,
      excludeReasons: ['rate_limit', 'usage_cap', 'timeout', 'verify_failed'],
      repeatThreshold: 3,
      maxPerRun: 5,
      maxPerDay: 20,
      selfFixLabel: 'no-auto-merge',
      bugLabels: ['bug'],
      sensitivePaths: ['packages/core/', 'packages/config/', 'packages/cli/', 'scripts/', '.github/'],
    }),
  ingest: z
    .object({
      enabled: z.boolean().default(false),
      label: z.string().default('ready'),
      lane: z.string().default('auto'),
      maxPerCycle: z.number().int().positive().default(20),
      comment: z.string().optional(),
    })
    .default({ enabled: false, label: 'ready', lane: 'auto', maxPerCycle: 20 }),
  intake: z
    .object({
      trustedApprovers: z.array(z.string().min(1)).optional(),
      enforce: z.enum(['warn', 'enforce']).default('warn'),
      comment: z.string().optional(),
    })
    .default({ enforce: 'warn' }),
  environment: z
    .object({
      ports: z
        .object({
          enabled: z.boolean().default(true),
          range: z
            .tuple([z.number().int().min(1024).max(65535), z.number().int().min(1024).max(65535)])
            .default([3100, 3999]),
          comment: z.string().optional(),
        })
        .refine((p) => p.range[0] <= p.range[1], { message: 'ports.range must be [low, high]' })
        .default({ enabled: true, range: [3100, 3999] }),
      processGroups: z
        .object({ graceMs: z.number().int().positive().default(5000), comment: z.string().optional() })
        .default({ graceMs: 5000 }),
      proxy: z
        .object({
          enabled: z.boolean().default(false),
          port: z.number().int().min(1).max(65535).default(80),
          domain: z.string().default('factory.localhost'),
          comment: z.string().optional(),
        })
        .default({ enabled: false, port: 80, domain: 'factory.localhost' }),
    })
    .default({
      ports: { enabled: true, range: [3100, 3999] },
      processGroups: { graceMs: 5000 },
      proxy: { enabled: false, port: 80, domain: 'factory.localhost' },
    }),
  host: z
    .object({
      maxBuilds: z.number().int().positive().default(2),
      maxAgentJobs: z.number().int().positive().default(1),
      loadGuard: z
        .object({
          enabled: z.boolean().default(true),
          maxLoad: z.number().positive().optional(),
          retrySeconds: z.number().int().positive().default(60),
        })
        .default({ enabled: true, retrySeconds: 60 }),
      comment: z.string().optional(),
    })
    .default({ maxBuilds: 2, maxAgentJobs: 1, loadGuard: { enabled: true, retrySeconds: 60 } }),
  auto_failover: z
    .object({
      enabled: z.boolean().default(true),
      cooldown_minutes: z.number().positive().default(30),
      fallback_model: z.string().default('claude-sonnet-5'),
      comment: z.string().optional(),
    })
    .default({ enabled: true, cooldown_minutes: 30, fallback_model: 'claude-sonnet-5' }),
  queue: z
    .object({
      claim_settle_ms: z
        .number()
        .int()
        .nonnegative()
        .default(3000)
        .describe(
          'Milliseconds a lane waits after writing its claim before confirming it (#3145). 0 turns the wait off.',
        ),
      max_review_rework_runs: z
        .number()
        .int()
        .nonnegative()
        .default(2)
        .describe(
          'Review-rework runs allowed per issue (#3565). At the cap a trusted changes-requested review starts no run and parks the issue. 0 always parks.',
        ),
      comment: z.string().optional(),
    })
    .default({ claim_settle_ms: 3000, max_review_rework_runs: 2 }),
  adr: z.object({ mandate: z.boolean().default(false), comment: z.string().optional() }).default({ mandate: false }),
  /** Ship-it lane workspace isolation (#1535). `'host'` is the existing sibling-worktree
   *  behavior; `'disposable-docker'` opts a repo into a managed, labeled container per
   *  lane via the existing hosted ContainerEngine. Default-off — every existing repo is
   *  unaffected unless it explicitly opts in. */
  workspace: z
    .object({
      backend: z.enum(['host', 'disposable-docker']).default('host'),
      comment: z.string().optional(),
    })
    .default({ backend: 'host' }),
});

// ---------- Types ----------
// `harnesses` is always present on a parsed config but optional to construct, so
// hand-built configs (tests, sims) need not spell out an empty section.
export type ModelsConfig = Omit<z.infer<typeof ModelsConfigSchema>, 'harnesses'> & {
  harnesses?: Record<string, HarnessDeclaration>;
};
export type RoutesConfig = z.infer<typeof RoutesConfigSchema>;
export type FactoryConfig = z.infer<typeof FactoryConfigSchema>;

// ---------- Loaders ----------

export function loadModelsConfig(path?: string): ModelsConfig {
  const raw = path === undefined ? defaultModelsConfig : JSON.parse(readFileSync(path, 'utf-8'));
  const parsed = ModelsConfigSchema.parse(raw);
  for (const w of failoverConfigWarnings((raw as { failover?: unknown } | null)?.failover, 'failover')) {
    console.warn(`factory: ${w}`);
  }
  if (path === undefined) {
    for (const [id, def] of Object.entries(parsed.models)) {
      if (isOpenCodeZenModel(id, def)) {
        throw new Error(`Packaged model '${id}' is an OpenCode Zen (opencode/) model; Zen is never shipped (#3334)`);
      }
    }
  }
  return parsed;
}

export function loadRoutesConfig(path?: string): RoutesConfig {
  const raw = path === undefined ? defaultRoutesConfig : JSON.parse(readFileSync(path, 'utf-8'));
  return RoutesConfigSchema.parse(raw);
}

export function loadFactoryConfig(path?: string): FactoryConfig {
  const raw = path === undefined ? defaultFactoryConfig : JSON.parse(readFileSync(path, 'utf-8'));
  return FactoryConfigSchema.parse(raw);
}

/** Top-level keys of `.factory/config.json` owned by FactoryConfigSchema (runtime policy).
 *  The rest of the file belongs to RepoFactoryConfigSchema's model-routing namespace in
 *  ./repo.ts, and each loader ignores the other's keys. `version` is deliberately absent:
 *  it is the repo namespace's literal, and FactoryConfig's version comes from the defaults.
 *  Adding a new top-level section to FactoryConfigSchema means adding it here too. */
export { FACTORY_RUNTIME_CONFIG_KEYS } from './runtime-config-keys.js';

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Narrow a known-object value to a plain record via the isPlainObject type guard rather than a
 *  type assertion — `defaultFactoryConfig` has no index signature, so it cannot be cast directly. */
function asRecord(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) throw new Error('expected a plain object');
  return value;
}

/** Recursive merge of plain objects only — arrays and tuples (e.g. environment.ports.range)
 *  replace wholesale rather than merging element-wise. */
function deepMergeConfig(base: Record<string, unknown>, overlay: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const current = out[key];
    out[key] = isPlainObject(current) && isPlainObject(value) ? deepMergeConfig(current, value) : value;
  }
  return out;
}

export interface ConfigSchemaIssue {
  path: (string | number)[];
  message: string;
  code: string;
  keys?: string[];
}

/** Flatten a zod error into plain issues (symbol path segments dropped). */
export function toConfigSchemaIssues(error: z.ZodError): ConfigSchemaIssue[] {
  return error.issues.map((i) => ({
    path: i.path.filter((p) => typeof p !== 'symbol') as (string | number)[],
    message: i.message,
    code: i.code,
    keys: 'keys' in i ? (i.keys as string[]) : undefined,
  }));
}

function mergeRuntimeOverlay(raw: Record<string, unknown>): Record<string, unknown> {
  const overlay: Record<string, unknown> = {};
  for (const key of FACTORY_RUNTIME_CONFIG_KEYS) {
    if (key in raw) overlay[key] = raw[key];
  }
  return deepMergeConfig(asRecord(defaultFactoryConfig), overlay);
}

/** Schema issues for the runtime-policy keys of a parsed repo config file; `[]` when valid. Pure. */
export function factoryRuntimeConfigIssues(raw: Record<string, unknown>): ConfigSchemaIssue[] {
  const result = FactoryConfigSchema.safeParse(mergeRuntimeOverlay(raw));
  return result.success ? [] : toConfigSchemaIssues(result.error);
}

/** Load the effective FactoryConfig for a repo: the shipped defaults, with the runtime-policy
 *  keys of the repo config file (`.factory/config.yaml|yml|json`, i.e. `getFactoryPaths(repoRoot).config`) merged
 *  over them. Returns the shipped defaults untouched when the file does not exist. A partial
 *  section is legal — `{"merge": {"auto": true}}` overrides only `merge.auto`. The file's
 *  model-routing keys are ignored here; `loadRepoConfig` owns them. */
export function loadFactoryConfigForRepo(configPath: string): FactoryConfig {
  const explicit = runConfigSource();
  if (explicit === undefined && !existsSync(configPath)) return loadFactoryConfig();

  let raw: unknown;
  if (explicit !== undefined) {
    try {
      raw = JSON.parse(explicit);
    } catch (err) {
      throw new Error(`Failed to parse ${configPath}: ${(err as Error).message}`, { cause: err });
    }
  } else {
    raw = readRepoConfigFile(configPath);
  }
  if (!isPlainObject(raw)) {
    throw new Error(`Invalid ${configPath}: expected a JSON object`);
  }

  const result = FactoryConfigSchema.safeParse(mergeRuntimeOverlay(raw));
  if (!result.success) {
    const issues = toConfigSchemaIssues(result.error)
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid ${configPath}: ${issues}`);
  }
  return result.data;
}

export function resolveTimeouts(
  config: FactoryConfig,
  env: NodeJS.ProcessEnv = process.env,
): { plan: number; build: number; check: number; approval: number; tests: number; compile: number } {
  const fromEnv = (v?: string) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };

  return {
    plan: fromEnv(env.FACTORY_PLAN_TIMEOUT) ?? config.timeouts.plan_seconds ?? 1800,
    build: fromEnv(env.FACTORY_BUILD_TIMEOUT) ?? config.timeouts.build_seconds ?? 7200,
    check: fromEnv(env.FACTORY_CHECK_TIMEOUT) ?? config.timeouts.check_seconds ?? 1800,
    approval: fromEnv(env.FACTORY_APPROVAL_TIMEOUT) ?? config.timeouts.approval_seconds ?? 1800,
    tests: fromEnv(env.FACTORY_TESTS_TIMEOUT) ?? config.timeouts.tests_seconds ?? 300,
    compile: fromEnv(env.FACTORY_COMPILE_TIMEOUT) ?? config.timeouts.compile_seconds ?? 120,
  };
}

/** Single '1'/'0'/unset toggle evaluation shared by every boolean resolver. An
 *  explicit '1' wins, an explicit '0' loses, and anything else (unset, empty,
 *  'true') falls back to the caller's default. */
function resolveEnabledFlag(env: NodeJS.ProcessEnv, envVar: string, fallback: boolean): boolean {
  if (env[envVar] === '1') return true;
  if (env[envVar] === '0') return false;
  return fallback;
}

export function resolveSkipCI(config: FactoryConfig, env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveEnabledFlag(env, 'FACTORY_SKIP_CI', config.ci?.skip ?? false);
}

/** SHIP's CI watch deadline (#3569): ci.watchMinutes as ms; unset, non-finite or <= 0 → DEFAULT_CI_DEADLINE_MS. */
export function resolveCiWatchDeadlineMs(config: { ci?: { watchMinutes?: number } }): number {
  const m = config.ci?.watchMinutes;
  return typeof m === 'number' && Number.isFinite(m) && m > 0 ? Math.round(m * 60_000) : DEFAULT_CI_DEADLINE_MS;
}

/** Hours an awaiting-ci PR is re-checked before it parks as ci-never-started (#3208), as ms; unset, non-finite or <= 0 → 24h. */
export function resolveAwaitingCiCapMs(config: { ci?: { awaitingCiCapHours?: number } }): number {
  const h = config.ci?.awaitingCiCapHours;
  return typeof h === 'number' && Number.isFinite(h) && h > 0 ? Math.round(h * 3_600_000) : 24 * 3_600_000;
}

/**
 * sizeGate.mode values this build understands (ADR-0147). `slice` keeps an oversized issue whole and ships it as slice PRs.
 * `stack` (ADR-0161) will ship a stacked PR set; until that is built the size gate runs it as `slice`. */
export const SIZE_GATE_MODES = ['file', 'slice', 'off', 'stack'] as const;
export type SizeGateMode = (typeof SIZE_GATE_MODES)[number];

/** Exact match against SIZE_GATE_MODES; anything else is undefined. */
export function parseSizeGateMode(raw: unknown): SizeGateMode | undefined {
  return (SIZE_GATE_MODES as readonly unknown[]).includes(raw) ? (raw as SizeGateMode) : undefined;
}

/** sizeGate.mode from the factory config; missing or unknown resolves to `file`. */
export function resolveSizeGateMode(config: FactoryConfig): SizeGateMode {
  return parseSizeGateMode(config.sizeGate?.mode) ?? 'file';
}

/** --max-slices value: a whole number from 1 to SLICE_CAP_CEILING, else undefined (ADR-0156). */
export function parseMaxSlices(raw: string): number | undefined {
  if (!/^\d+$/.test(raw)) return undefined;
  const n = Number(raw);
  return n >= 1 && n <= SLICE_CAP_CEILING ? n : undefined;
}

/** sizeGate.maxSlices from the factory config; absent resolves to DEFAULT_MAX_SLICES (10). */
export function resolveSizeGateMaxSlices(config: FactoryConfig): number {
  return config.sizeGate?.maxSlices ?? DEFAULT_MAX_SLICES;
}

export function resolveSizeGateBudget(config: FactoryConfig): SizeBudget {
  const { tokenBudget = DEFAULT_TOKEN_BUDGET, maxFiles = DEFAULT_MAX_FILES } = config.sizeGate ?? {};
  return { tokenBudget, maxFiles };
}

export function resolveBuildPublish(config: FactoryConfig, env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveEnabledFlag(env, 'FACTORY_BUILD_PUBLISH', config.build?.publishFromBuild ?? false);
}

export function resolveDesignRegressionBlock(config: FactoryConfig, env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveEnabledFlag(
    env,
    'FACTORY_DESIGN_BLOCK_REGRESSIONS',
    config.design?.blockUnresolvedRegressions ?? false,
  );
}

export function resolveReadinessUpdateIssueBody(config: FactoryConfig, env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveEnabledFlag(env, 'FACTORY_READINESS_UPDATE_BODY', config.readiness?.updateIssueBody ?? true);
}

export function resolvePlanApproval(config: FactoryConfig, env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveEnabledFlag(env, 'FACTORY_APPROVE_PLAN', config.plan_approval?.enabled ?? false);
}

export function resolveAdrMandate(config: FactoryConfig, env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveEnabledFlag(env, 'FACTORY_ADR_MANDATE', config.adr?.mandate ?? false);
}

export function resolveDefectWindowDays(config: FactoryConfig, env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.FACTORY_DEFECT_WINDOW_DAYS);
  if (Number.isFinite(n) && n > 0) return n;
  return config.kpis?.defectWindowDays ?? 14;
}

export interface IngestSettings {
  enabled: boolean;
  label: string;
  lane: string;
  maxPerCycle: number;
}

export function resolveIngestConfig(config: FactoryConfig, env: NodeJS.ProcessEnv = process.env): IngestSettings {
  const i = config.ingest;
  return {
    enabled: resolveEnabledFlag(env, 'FACTORY_AUTO_INGEST', i?.enabled ?? false),
    label: i?.label ?? 'ready',
    lane: i?.lane ?? 'auto',
    maxPerCycle: i?.maxPerCycle ?? 20,
  };
}

export interface EnvironmentPortsSettings {
  enabled: boolean;
  range: [number, number];
}

export function resolveEnvironmentPorts(
  config: FactoryConfig,
  env: NodeJS.ProcessEnv = process.env,
): EnvironmentPortsSettings {
  return {
    enabled: resolveEnabledFlag(env, 'FACTORY_ENV_PORTS', config.environment?.ports?.enabled ?? true),
    range: config.environment?.ports?.range ?? [3100, 3999],
  };
}

export interface EnvironmentProxySettings {
  enabled: boolean;
  port: number;
  domain: string;
}

export function resolveEnvironmentProxy(
  config: FactoryConfig,
  env: NodeJS.ProcessEnv = process.env,
): EnvironmentProxySettings {
  return {
    enabled: resolveEnabledFlag(env, 'FACTORY_PROXY', config.environment?.proxy?.enabled ?? false),
    port: config.environment?.proxy?.port ?? 80,
    domain: config.environment?.proxy?.domain ?? 'factory.localhost',
  };
}

export interface AutoFailoverSettings {
  enabled: boolean;
  cooldownMs: number;
  fallbackModel: string;
}

/** Failover policy comes from validated configuration, never inherited process state. */
export function resolveAutoFailover(config: FactoryConfig): AutoFailoverSettings {
  return {
    enabled: config.auto_failover?.enabled ?? defaultFactoryConfig.auto_failover.enabled,
    cooldownMs:
      (config.auto_failover?.cooldown_minutes ?? defaultFactoryConfig.auto_failover.cooldown_minutes) * 60_000,
    fallbackModel: config.auto_failover?.fallback_model ?? defaultFactoryConfig.auto_failover.fallback_model,
  };
}

/** Host-wide cap on lanes inside BUILD or CHECK at once (#3043). */
export function resolveHostMaxAgentJobs(config: FactoryConfig): number {
  return config.host?.maxAgentJobs ?? defaultFactoryConfig.host.maxAgentJobs;
}

export function resolveHostMaxBuilds(config: FactoryConfig): number {
  return config.host?.maxBuilds ?? defaultFactoryConfig.host.maxBuilds;
}

/** Host load guard policy (#3048). FACTORY_LOAD_GUARD=1/0 beats host.loadGuard.enabled. */
export interface HostLoadGuardPolicy {
  enabled: boolean;
  maxLoad?: number;
  retryMs: number;
}

export function resolveHostLoadGuard(config: FactoryConfig, env: NodeJS.ProcessEnv = process.env): HostLoadGuardPolicy {
  const d = defaultFactoryConfig.host.loadGuard;
  const g = config.host?.loadGuard;
  return {
    enabled: resolveEnabledFlag(env, 'FACTORY_LOAD_GUARD', g?.enabled ?? d.enabled),
    maxLoad: g?.maxLoad,
    retryMs: (g?.retrySeconds ?? d.retrySeconds) * 1000,
  };
}

/** Local-only mode: restrict routing to local worker models and force the
 *  build route to codex (FACTORY_LOCAL_ONLY=1). */
export function resolveLocalOnly(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveEnabledFlag(env, 'FACTORY_LOCAL_ONLY', false);
}

/** Experimental models: make experimental-tier models eligible for routing (FACTORY_EXPERIMENTAL=1). */
export function resolveExperimental(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveEnabledFlag(env, 'FACTORY_EXPERIMENTAL', false);
}

/** Branch-name prefix shared by ship, land, and ingest so they agree on which
 *  factory branches/worktrees belong to this run. */
export function resolveBranchPrefix(): string {
  return 'factory';
}

/** Grace period (ms) between SIGTERM and SIGKILL when sweeping a lane's
 *  process groups on terminal state or reaping a dead lane's orphans. */
export function resolveProcessGroupGraceMs(config: FactoryConfig): number {
  return config.environment?.processGroups?.graceMs ?? 5000;
}

/** Where a resolved merge decision came from. `'flag'` is an explicit per-invocation CLI
 *  flag (`--auto-merge`/`--no-auto-merge`) and outranks every other source. */
export type MergePolicySource = ConfigSource;

export interface EffectiveMergePolicy {
  auto: boolean;
  admin: boolean;
  sources: { auto: MergePolicySource; admin: MergePolicySource };
}

/** Per-invocation CLI overrides. A field left `undefined` means "the flag was not
 *  supplied" and changes nothing; a boolean wins over config file and env alike. */
export interface MergePolicyOverrides {
  auto?: boolean;
  /** From `--pr-classifier` / `--no-pr-classifier` (#1724). */
  classifier?: boolean;
}

export interface EffectivePrClassifierPolicy {
  enabled: boolean;
  source: MergePolicySource;
}

/** Resolve the PR classifier gate (#1724): flag > run.merge.classifier > FACTORY_PR_CLASSIFIER=1 > off. */
export function resolvePrClassifierPolicy(
  config: FactoryConfig,
  env: NodeJS.ProcessEnv = process.env,
  overrides: MergePolicyOverrides = {},
): EffectivePrClassifierPolicy {
  const { value, source } = resolvePrecedence<boolean>(
    [
      { source: 'flag', read: () => overrides.classifier },
      { source: 'repo', read: () => config.run?.merge?.classifier },
      { source: 'env', read: () => (env.FACTORY_PR_CLASSIFIER === '1' ? true : undefined) },
    ],
    false,
  );
  return { enabled: value, source };
}

/** Resolve auto-merge/admin-merge: an explicit per-invocation `overrides.auto` (from
 *  `--auto-merge`/`--no-auto-merge`) is highest-precedence > `run.merge.*` (present ⇒ from
 *  the repo file, and authoritative — an explicit `false` here is NOT overridden by the
 *  legacy env var) > legacy `merge.auto: true` (there is no legacy admin field) >
 *  `FACTORY_MERGE` / `FACTORY_MERGE_ADMIN` env > default `false`. This is a deliberate
 *  behavior change from the prior `merge.auto || FACTORY_MERGE === '1'` OR semantics (see ADR). */
export function resolveMergePolicy(
  config: FactoryConfig,
  env: NodeJS.ProcessEnv = process.env,
  overrides: MergePolicyOverrides = {},
): EffectiveMergePolicy {
  const auto = resolvePrecedence<boolean>(
    [
      { source: 'flag', read: () => overrides.auto },
      { source: 'repo', read: () => config.run?.merge?.auto },
      { source: 'repo', read: () => (config.merge.auto ? true : undefined) },
      { source: 'env', read: () => (env.FACTORY_MERGE === '1' ? true : undefined) },
    ],
    false,
  );
  const admin = resolvePrecedence<boolean>(
    [
      { source: 'repo', read: () => config.run?.merge?.admin },
      { source: 'env', read: () => (env.FACTORY_MERGE_ADMIN === '1' ? true : undefined) },
    ],
    false,
  );

  return { auto: auto.value, admin: admin.value, sources: { auto: auto.source, admin: admin.source } };
}

export function resolveFilingPolicy(config: FactoryConfig): FilingPolicy {
  const f = config.filing;
  return {
    enabled: f.enabled,
    // Validated as free-form strings by the Zod schema; narrowed here to the FailoverReason union.
    excludeReasons: f.excludeReasons as FailoverReason[],
    repeatThreshold: f.repeatThreshold,
    maxPerRun: f.maxPerRun,
    maxPerDay: f.maxPerDay,
    selfFixLabel: f.selfFixLabel,
    bugLabels: f.bugLabels,
    sensitivePaths: f.sensitivePaths,
  };
}

// ---------- Factory state paths ----------

/** `root` holds only the committed
 *  inputs — the repo config file (`config.yaml`/`config.yml`/`config.json`), plus the CLI-written `constitution.md`/`.gitignore` — so a
 *  consumer repo can gitignore just `state/` and keep those three files tracked. Every
 *  other runtime path resolves under `<root>/state/`. The root is the explicit `stateRoot`
 *  argument, else `FACTORY_STATE_ROOT` (see `resolveStateRoot`), else `<repoRoot>/.factory`. */
export function getFactoryPaths(repoRoot: string, stateRoot?: string, env: NodeJS.ProcessEnv = process.env) {
  const root =
    stateRoot !== undefined
      ? resolve(stateRoot)
      : (resolveStateRoot(env[STATE_ROOT_ENV], { repoRoot }) ?? resolve(repoRoot, '.factory'));
  const state = resolve(root, 'state');
  return {
    root,
    state,
    config: resolveRepoConfigPath(root),
    queue: resolve(state, 'queue'),
    queueProposed: resolve(state, 'queue.proposed'),
    events: resolve(state, 'events.ndjson'),
    logs: resolve(state, 'logs'),
    plans: resolve(state, 'plans'),
    reports: resolve(state, 'reports'),
    runs: resolve(state, 'runs'),
    mergeLock: resolve(state, 'merge.lock'),
    gitLock: resolve(state, 'git.lock'),
    runLock: resolve(state, 'run.lock'),
    product: resolve(state, 'product'),
    stop: resolve(state, 'STOP'),
    costs: resolve(state, 'costs.jsonl'),
    approvals: resolve(state, 'approvals'),
    steering: resolve(state, 'steering'),
    kpiHistory: resolve(state, 'kpi-history.jsonl'),
    kpiSweepCache: resolve(state, 'kpi-sweep-cache.json'),
    orphanDraftSweep: resolve(state, 'orphan-draft-sweep.json'),
    classifierOutcomes: resolve(state, 'classifier-outcomes.jsonl'),
    ingestWatermark: resolve(state, 'ingest-watermark'),
    ports: resolve(process.env.FACTORY_DAEMON_PORTS_DIR ?? state, 'ports.json'),
    portsLock: resolve(process.env.FACTORY_DAEMON_PORTS_DIR ?? state, 'ports.lock'),
    proxyState: resolve(state, 'proxy.json'),
    breaker: resolve(state, 'breaker.json'),
    reworkHistory: resolve(state, 'rework-history.json'),
    reviewRework: resolve(state, 'review-rework.json'),
    baselineCache: resolve(state, 'baseline-cache.json'),
    readinessCache: resolve(state, 'readiness-cache'),
    baseHold: resolve(state, 'base-hold.json'),
    flakyLedger: resolve(state, 'flaky-tests.json'),
    laneFiles: resolve(state, 'lane-files.json'),
    worktreeKeeps: resolve(state, 'worktree-keeps.json'),
    /** Per-invocation CLI flag overrides recorded by `factory run` so a separate
     *  `factory status` process can attribute the policy to the flag (#1400). */
    runFlags: resolve(state, 'run-flags.json'),
  };
}

// ---------- Constitution resolution ----------

export function getConstitutionsDir(): string {
  return resolveConfigPath('constitutions');
}

// ---------- Unified v2 config schema (additive; v1 loaders above are untouched) ----------

export {
  FactoryConfigV2Schema,
  factoryConfigV2JsonSchema,
  loadV2Config,
  parseV2Config,
  type FactoryConfigV2,
} from './v2.js';
