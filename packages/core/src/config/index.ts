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
  defaultSchemaFields,
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
import { runConfigSource } from './run-config-env.js';
import { RunConfigSectionSchema } from './run-section.js';
export { resolveBranchPrefix, type BranchPrefixConfig } from './run-section.js';
import { PrConfigSections } from './pr-section.js';
import { DiskConfigSchema } from './disk-policy.js';
import { FACTORY_RUNTIME_CONFIG_KEYS } from './runtime-config-keys.js';

import type { FilingPolicy } from '../filing/policy.js';
import { builtInHarnessRedeclaredMessage, KNOWN_HARNESS_IDS, retiredHarnessReplacement } from '../harness/catalog.js';
import type { FailoverReason } from '../types/index.js';
import { SandboxConfigSchema, warnCodexSandboxOnce } from './sandbox-schema.js';
import { GitHubConfigSchema } from './github-section.js';
import { TrackerConfigSchema } from './tracker-section.js';
import { markSizeGateModeWarned, warnSizeGateModeOnce } from './size-gate.js';
import { ModelEffortsSchema } from './effort.js';
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

const { paths: dPaths, timeouts: dTimeouts, merge: dMerge, worktree: dWorktree, ci: dCi } = defaultFactoryConfig;
const { sweep: dSweep, plan_approval: dPlanApproval, design: dDesign, readiness: dReadiness } = defaultFactoryConfig;
const { build: dBuild, kpis: dKpis, discovery: dDiscovery, filing: dFiling, ingest: dIngest } = defaultFactoryConfig;
const { intake: dIntake, host: dHost, auto_failover: dFailover, queue: dQueue } = defaultFactoryConfig;
const { ports: dPorts, proxy: dProxy } = defaultFactoryConfig.environment;

/** A defaultFactoryConfig section without its prose `comment`, so object-level defaults keep today's keys (#3444). */
function withoutComment<T extends { comment?: string }>(section: T): Omit<T, 'comment'> {
  const { comment: _comment, ...rest } = section;
  return rest;
}

export const FactoryConfigSchema = z.object({
  version: z.number(),
  paths: z.object({
    constitutions: z.string(),
    checkers: z.string(),
    plans: z.string(),
    logs: z.string(),
    events: z.string(),
    constitution: z.string().default(dPaths.constitution),
  }),
  timeouts: z.object({
    plan_seconds: z.number(),
    build_seconds: z.number(),
    check_seconds: z.number(),
    merge_poll_seconds: z.number(),
    approval_seconds: z.number().default(dTimeouts.approval_seconds),
    tests_seconds: z.number().default(dTimeouts.tests_seconds),
    compile_seconds: z.number().default(dTimeouts.compile_seconds),
  }),
  merge: z.object({
    auto: z.boolean(),
    admin: z.boolean().default(defaultSchemaFields.mergeAdmin),
    comment: z.string(),
    maxConflictRounds: z.number().int().min(1).max(10).default(dMerge.maxConflictRounds),
    maxLandDeferrals: z.number().int().min(1).max(10).default(dMerge.maxLandDeferrals),
  }),
  /** `run.merge.*` mirrors the `run.merge` shape of RepoFactoryConfigV2Schema in `config/repo.ts` and, when present,
   *  is authoritative over the legacy top-level `merge.*` fields above (see
   *  `resolveMergePolicy`). Left optional with no defaults so "unset" survives parsing
   *  and is distinguishable from an explicit `false`. */
  run: RunConfigSectionSchema,
  ...PrConfigSections,
  worktree: z.object({
    parent: z.string(),
    comment: z.string(),
    gcTtlDays: z.number().default(dWorktree.gcTtlDays),
    autoGcOnRun: z.boolean().default(dWorktree.autoGcOnRun),
    retainMax: z.number().int().nonnegative().default(dWorktree.retainMax),
    stateBackupKeep: z.number().int().nonnegative().default(dWorktree.stateBackupKeep),
    stateBackupMaxAgeDays: z.number().nonnegative().default(dWorktree.stateBackupMaxAgeDays),
  }),
  byok: z.object({ enabled: z.boolean(), comment: z.string() }),
  notifications: z.record(z.string(), z.boolean()),
  cost_tracking: z.object({ enabled: z.boolean(), log_file: z.string(), comment: z.string() }),
  ci: z
    .object({
      skip: z.boolean().default(dCi.skip),
      watchMinutes: z.number().optional().catch(undefined),
      awaitingCiCapHours: z.number().optional().catch(undefined),
      comment: z.string().default(defaultSchemaFields.ciComment),
    })
    .default({ skip: dCi.skip, comment: defaultSchemaFields.ciComment }),
  ship: z
    .object({ ciWatchMinutes: z.number().optional().catch(undefined), comment: z.string().optional() })
    .default({}),
  sweep: z
    .object({
      heartbeatFile: z.string().optional(),
      loopIntervalSeconds: z.number().int().positive().default(dSweep.loopIntervalSeconds),
      staleThresholdMultiplier: z.number().positive().default(dSweep.staleThresholdMultiplier),
      comment: z.string().optional(),
    })
    .default(withoutComment(dSweep)),
  plan_approval: z
    .object({ enabled: z.boolean().default(dPlanApproval.enabled), comment: z.string().optional() })
    .default({ enabled: dPlanApproval.enabled }),
  design: z
    .object({ blockUnresolvedRegressions: z.boolean().default(dDesign.blockUnresolvedRegressions) })
    .default({ blockUnresolvedRegressions: dDesign.blockUnresolvedRegressions }),
  readiness: z
    .object({ updateIssueBody: z.boolean().default(dReadiness.updateIssueBody) })
    .default({ updateIssueBody: dReadiness.updateIssueBody }),
  build: z
    .object({
      publishFromBuild: z.boolean().default(dBuild.publishFromBuild),
      contextCeiling: z.record(z.string(), z.number().int().nonnegative()).default({ ...dBuild.contextCeiling }),
    })
    .default({ publishFromBuild: dBuild.publishFromBuild, contextCeiling: { ...dBuild.contextCeiling } }),
  // Plain string on purpose: an unknown mode must load, resolve to `stack` and warn, not throw (ADR-0160, #3850).
  sizeGate: z
    .object({
      mode: z.string().optional(),
      maxSlices: z.number().int().min(1).max(SLICE_CAP_CEILING).optional(),
      tokenBudget: z.number().int().positive().optional(),
      maxFiles: z.number().int().positive().optional(),
    })
    .default({}),
  kpis: z
    .object({
      defectWindowDays: z.number().int().positive().default(dKpis.defectWindowDays),
      comment: z.string().optional(),
    })
    .default({ defectWindowDays: dKpis.defectWindowDays }),
  events: EventsConfigSchema,
  sandbox: SandboxConfigSchema,
  discovery: z
    .object({
      enabled: z.boolean().default(dDiscovery.enabled),
      schedule: z.enum(['weekly', 'daily', 'manual']).default(dDiscovery.schedule),
      maxCandidates: z.number().int().positive().default(dDiscovery.maxCandidates),
      comment: z.string().optional(),
    })
    .default(withoutComment(dDiscovery)),
  filing: z
    .object({
      enabled: z.boolean().default(dFiling.enabled),
      excludeReasons: z.array(z.string()).default([...dFiling.excludeReasons]),
      repeatThreshold: z.number().int().positive().default(dFiling.repeatThreshold),
      maxPerRun: z.number().int().positive().default(dFiling.maxPerRun),
      maxPerDay: z.number().int().positive().default(dFiling.maxPerDay),
      selfFixLabel: z.string().default(dFiling.selfFixLabel),
      bugLabels: z.array(z.string()).default([...dFiling.bugLabels]),
      repo: z
        .string()
        .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'filing.repo must be owner/name')
        .optional(),
      sensitivePaths: z.array(z.string()).default([...dFiling.sensitivePaths]),
      comment: z.string().optional(),
    })
    .default({
      enabled: dFiling.enabled,
      excludeReasons: [...dFiling.excludeReasons],
      repeatThreshold: dFiling.repeatThreshold,
      maxPerRun: dFiling.maxPerRun,
      maxPerDay: dFiling.maxPerDay,
      selfFixLabel: dFiling.selfFixLabel,
      bugLabels: [...dFiling.bugLabels],
      sensitivePaths: [...dFiling.sensitivePaths],
    }),
  ingest: z
    .object({
      enabled: z.boolean().default(dIngest.enabled),
      label: z.string().default(dIngest.label),
      lane: z.string().default(dIngest.lane),
      maxPerCycle: z.number().int().positive().default(dIngest.maxPerCycle),
      comment: z.string().optional(),
    })
    .default(withoutComment(dIngest)),
  intake: z
    .object({
      trustedApprovers: z.array(z.string().min(1)).optional(),
      enforce: z.enum(['warn', 'enforce']).default(dIntake.enforce),
      comment: z.string().optional(),
    })
    .default({ enforce: dIntake.enforce }),
  environment: z
    .object({
      ports: z
        .object({
          enabled: z.boolean().default(dPorts.enabled),
          range: z
            .tuple([z.number().int().min(1024).max(65535), z.number().int().min(1024).max(65535)])
            .default([dPorts.range[0], dPorts.range[1]]),
          comment: z.string().optional(),
        })
        .refine((p) => p.range[0] <= p.range[1], { message: 'ports.range must be [low, high]' })
        .default({ enabled: dPorts.enabled, range: [dPorts.range[0], dPorts.range[1]] }),
      processGroups: z
        .object({
          graceMs: z.number().int().positive().default(defaultSchemaFields.processGroupGraceMs),
          comment: z.string().optional(),
        })
        .default({ graceMs: defaultSchemaFields.processGroupGraceMs }),
      proxy: z
        .object({
          enabled: z.boolean().default(dProxy.enabled),
          port: z.number().int().min(1).max(65535).default(dProxy.port),
          domain: z.string().default(dProxy.domain),
          comment: z.string().optional(),
        })
        .default({ enabled: dProxy.enabled, port: dProxy.port, domain: dProxy.domain }),
    })
    .default({
      ports: { enabled: dPorts.enabled, range: [dPorts.range[0], dPorts.range[1]] },
      processGroups: { graceMs: defaultSchemaFields.processGroupGraceMs },
      proxy: { enabled: dProxy.enabled, port: dProxy.port, domain: dProxy.domain },
    }),
  host: z
    .object({
      maxBuilds: z.number().int().positive().default(dHost.maxBuilds),
      maxAgentJobs: z.number().int().positive().default(dHost.maxAgentJobs),
      loadGuard: z
        .object({
          enabled: z.boolean().default(dHost.loadGuard.enabled),
          maxLoad: z.number().positive().optional(),
          retrySeconds: z.number().int().positive().default(dHost.loadGuard.retrySeconds),
        })
        .default({ enabled: dHost.loadGuard.enabled, retrySeconds: dHost.loadGuard.retrySeconds }),
      comment: z.string().optional(),
    })
    .default({
      maxBuilds: dHost.maxBuilds,
      maxAgentJobs: dHost.maxAgentJobs,
      loadGuard: { enabled: dHost.loadGuard.enabled, retrySeconds: dHost.loadGuard.retrySeconds },
    }),
  disk: DiskConfigSchema,
  auto_failover: z
    .object({
      enabled: z.boolean().default(dFailover.enabled),
      cooldown_minutes: z.number().positive().default(dFailover.cooldown_minutes),
      fallback_model: z.string().default(dFailover.fallback_model),
      comment: z.string().optional(),
    })
    .default(withoutComment(dFailover)),
  queue: z
    .object({
      claim_settle_ms: z
        .number()
        .int()
        .nonnegative()
        .default(dQueue.claim_settle_ms)
        .describe(
          'Milliseconds a lane waits after writing its claim before confirming it (#3145). 0 turns the wait off.',
        ),
      max_review_rework_runs: z
        .number()
        .int()
        .nonnegative()
        .default(dQueue.max_review_rework_runs)
        .describe(
          'Review-rework runs allowed per issue (#3565). At the cap a trusted changes-requested review starts no run and parks the issue. 0 always parks.',
        ),
      maxClockSkewMs: z
        .number()
        .int()
        .nonnegative()
        .default(dQueue.maxClockSkewMs)
        .describe('Max ms this clock may differ from GitHub before the stale-claim reaper refuses (#3149).'),
      stackOnOpenPrerequisite: z
        .boolean()
        .catch(dQueue.stackOnOpenPrerequisite)
        .describe('Stack on an open prerequisite PR (#3916).'),
      discovery_interval_ms: z
        .number()
        .int()
        .positive()
        .default(dQueue.discovery_interval_ms)
        .describe('Milliseconds between lane-discovery passes in a running factory run (#3920).'),
      comment: z.string().optional(),
    })
    .default({
      claim_settle_ms: dQueue.claim_settle_ms,
      max_review_rework_runs: dQueue.max_review_rework_runs,
      maxClockSkewMs: dQueue.maxClockSkewMs,
      discovery_interval_ms: dQueue.discovery_interval_ms,
      stackOnOpenPrerequisite: dQueue.stackOnOpenPrerequisite,
    }),
  adr: z
    .object({ mandate: z.boolean().default(defaultSchemaFields.adrMandate), comment: z.string().optional() })
    .default({ mandate: defaultSchemaFields.adrMandate }),
  /** Ship-it lane workspace isolation (#1535). `'host'` is the existing sibling-worktree
   *  behavior; `'disposable-docker'` opts a repo into a managed, labeled container per
   *  lane via the existing hosted ContainerEngine. Default-off — every existing repo is
   *  unaffected unless it explicitly opts in. */
  workspace: z
    .object({
      backend: z.enum(['host', 'disposable-docker']).default(defaultSchemaFields.workspaceBackend),
      comment: z.string().optional(),
    })
    .default({ backend: defaultSchemaFields.workspaceBackend }),
  tracker: TrackerConfigSchema.default({ kind: defaultSchemaFields.trackerKind }),
  github: GitHubConfigSchema,
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
export function deepMergeConfig(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>,
): Record<string, unknown> {
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
  warnCodexSandboxOnce(configPath, raw);
  const sizeGateWarned = warnSizeGateModeOnce(configPath, raw);

  const result = FactoryConfigSchema.safeParse(mergeRuntimeOverlay(raw));
  if (!result.success) {
    const issues = toConfigSchemaIssues(result.error)
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid ${configPath}: ${issues}`);
  }
  if (sizeGateWarned) markSizeGateModeWarned(result.data);
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
    plan: fromEnv(env.FACTORY_PLAN_TIMEOUT) ?? config.timeouts.plan_seconds ?? dTimeouts.plan_seconds,
    build: fromEnv(env.FACTORY_BUILD_TIMEOUT) ?? config.timeouts.build_seconds ?? dTimeouts.build_seconds,
    check: fromEnv(env.FACTORY_CHECK_TIMEOUT) ?? config.timeouts.check_seconds ?? dTimeouts.check_seconds,
    approval: fromEnv(env.FACTORY_APPROVAL_TIMEOUT) ?? config.timeouts.approval_seconds ?? dTimeouts.approval_seconds,
    tests: fromEnv(env.FACTORY_TESTS_TIMEOUT) ?? config.timeouts.tests_seconds ?? dTimeouts.tests_seconds,
    compile: fromEnv(env.FACTORY_COMPILE_TIMEOUT) ?? config.timeouts.compile_seconds ?? dTimeouts.compile_seconds,
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
  return resolveEnabledFlag(env, 'FACTORY_SKIP_CI', config.ci?.skip ?? dCi.skip);
}

/** SHIP's CI watch deadline (#3569, #3932): ship.ciWatchMinutes, then ci.watchMinutes, as ms; unset, non-finite or <= 0 → DEFAULT_CI_DEADLINE_MS. */
export function resolveCiWatchDeadlineMs(config: {
  ci?: { watchMinutes?: number };
  ship?: { ciWatchMinutes?: number };
}): number {
  for (const m of [config.ship?.ciWatchMinutes, config.ci?.watchMinutes]) {
    if (typeof m === 'number' && Number.isFinite(m) && m > 0) return Math.round(m * 60_000);
  }
  return DEFAULT_CI_DEADLINE_MS;
}

export {
  SIZE_GATE_MODES,
  type SizeGateMode,
  aliasDeprecatedSizeGateMode,
  isExplicitStackMode,
  parseSizeGateMode,
  resolveSizeGateMode,
  sizeGateDeprecationLine,
} from './size-gate.js';
export { resolveGitHubCredentialsConfig } from './github-section.js';
export {
  TRACKER_KINDS,
  type TrackerKind,
  TrackerConfigSchema,
  type TrackerConfig,
  type LinearTrackerConfig,
  DEFAULT_TRACKER_CONFIG,
  resolveTrackerConfig,
} from './tracker-section.js';

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
  return resolveEnabledFlag(env, 'FACTORY_BUILD_PUBLISH', config.build?.publishFromBuild ?? dBuild.publishFromBuild);
}

export function resolveDesignRegressionBlock(config: FactoryConfig, env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveEnabledFlag(
    env,
    'FACTORY_DESIGN_BLOCK_REGRESSIONS',
    config.design?.blockUnresolvedRegressions ?? dDesign.blockUnresolvedRegressions,
  );
}

export function resolveReadinessUpdateIssueBody(config: FactoryConfig, env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveEnabledFlag(
    env,
    'FACTORY_READINESS_UPDATE_BODY',
    config.readiness?.updateIssueBody ?? dReadiness.updateIssueBody,
  );
}

export function resolvePlanApproval(config: FactoryConfig, env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveEnabledFlag(env, 'FACTORY_APPROVE_PLAN', config.plan_approval?.enabled ?? dPlanApproval.enabled);
}

export function resolveAdrMandate(config: FactoryConfig, env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveEnabledFlag(env, 'FACTORY_ADR_MANDATE', config.adr?.mandate ?? defaultSchemaFields.adrMandate);
}

export function resolveDefectWindowDays(config: FactoryConfig, env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.FACTORY_DEFECT_WINDOW_DAYS);
  if (Number.isFinite(n) && n > 0) return n;
  return config.kpis?.defectWindowDays ?? dKpis.defectWindowDays;
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
    enabled: resolveEnabledFlag(env, 'FACTORY_AUTO_INGEST', i?.enabled ?? dIngest.enabled),
    label: i?.label ?? dIngest.label,
    lane: i?.lane ?? dIngest.lane,
    maxPerCycle: i?.maxPerCycle ?? dIngest.maxPerCycle,
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
    enabled: resolveEnabledFlag(env, 'FACTORY_ENV_PORTS', config.environment?.ports?.enabled ?? dPorts.enabled),
    range: config.environment?.ports?.range ?? [dPorts.range[0], dPorts.range[1]],
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
    enabled: resolveEnabledFlag(env, 'FACTORY_PROXY', config.environment?.proxy?.enabled ?? dProxy.enabled),
    port: config.environment?.proxy?.port ?? dProxy.port,
    domain: config.environment?.proxy?.domain ?? dProxy.domain,
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

/** Grace period (ms) between SIGTERM and SIGKILL when sweeping a lane's
 *  process groups on terminal state or reaping a dead lane's orphans. */
export function resolveProcessGroupGraceMs(config: FactoryConfig): number {
  return config.environment?.processGroups?.graceMs ?? defaultSchemaFields.processGroupGraceMs;
}

export {
  resolveMergePolicy,
  resolvePrClassifierPolicy,
  type EffectiveMergePolicy,
  type EffectivePrClassifierPolicy,
  type MergePolicyOverrides,
  type MergePolicySource,
} from './merge-policy.js';

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
    landSlotLock: resolve(state, 'land-slot.lock'),
    gitLock: resolve(state, 'git.lock'),
    runLock: resolve(state, 'run.lock'),
    runLocks: resolve(state, 'locks', 'run'),
    product: resolve(state, 'product'),
    stop: resolve(state, 'STOP'),
    costs: resolve(state, 'costs.jsonl'),
    approvals: resolve(state, 'approvals'),
    steering: resolve(state, 'steering'),
    kpiHistory: resolve(state, 'kpi-history.jsonl'),
    kpiSweepCache: resolve(state, 'kpi-sweep-cache.json'),
    orphanDraftSweep: resolve(state, 'orphan-draft-sweep.json'),
    classifierOutcomes: resolve(state, 'classifier-outcomes.jsonl'),
    tierDemotions: resolve(state, 'tier-demotions.jsonl'),
    ingestWatermark: resolve(state, 'ingest-watermark'),
    ports: resolve(process.env.FACTORY_DAEMON_PORTS_DIR ?? state, 'ports.json'),
    portsLock: resolve(process.env.FACTORY_DAEMON_PORTS_DIR ?? state, 'ports.lock'),
    proxyState: resolve(state, 'proxy.json'),
    breaker: resolve(state, 'breaker.json'),
    reworkHistory: resolve(state, 'rework-history.json'),
    reviewRework: resolve(state, 'review-rework.json'),
    iterate: resolve(state, 'iterate.json'),
    baselineCache: resolve(state, 'baseline-cache.json'),
    readinessCache: resolve(state, 'readiness-cache'),
    baseHold: resolve(state, 'base-hold.json'),
    flakyLedger: resolve(state, 'flaky-tests.json'),
    laneFiles: resolve(state, 'lane-files.json'),
    worktreeKeeps: resolve(state, 'worktree-keeps.json'),
    /** Per-invocation CLI flag overrides recorded by `factory run` so a separate
     *  `factory status` process can attribute the policy to the flag (#1400). */
    runFlags: resolve(state, 'run-flags.json'),
    /** Running and waiting lanes of the active `factory run`, read by `factory status` (#3958). */
    laneSlots: resolve(state, 'lane-slots.json'),
  };
}

export function getConstitutionsDir(): string {
  return resolveConfigPath('constitutions');
}
