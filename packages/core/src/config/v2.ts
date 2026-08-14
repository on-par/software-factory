// packages/core/src/config/v2.ts — Unified v2 factory configuration (single sparse overlay schema)

import { existsSync, readFileSync } from 'node:fs';

import { z } from 'zod';

import { KNOWN_HARNESS_IDS } from '../harness/catalog.js';
import { getFactoryPaths } from './index.js';

// ---------- Models ----------

const ModelDefV2Schema = z
  .object({
    provider: z.enum(['anthropic', 'openai', 'ollama', 'deepseek', 'custom']).describe('Model provider.'),
    tier: z.union([z.string(), z.array(z.string())]).describe('Tier(s) this model belongs to.'),
    costPerMtokInput: z.number().describe('Cost in USD per million input tokens.'),
    costPerMtokOutput: z.number().describe('Cost in USD per million output tokens.'),
    contextWindow: z.number().describe('Model context window size, in tokens.'),
    capabilities: z.array(z.string()).default([]).describe('Free-form capability tags for this model.'),
    envKey: z.string().nullable().default(null).describe('Env var name holding this model API key, if any.'),
    claudeFlag: z.string().optional().describe('CLI flag passed to the Claude harness to select this model.'),
    providerModel: z.string().optional().describe('Underlying provider-specific model id, if different.'),
    providerOptions: z.record(z.string(), z.unknown()).optional().describe('Provider-specific extra options.'),
    codex: z.boolean().optional().describe('Whether this model is served via the Codex CLI harness.'),
    codexFlag: z.string().optional().describe('CLI flag passed to the Codex harness to select this model.'),
    harness: z.string().optional().describe('Harness id that executes this model (must be a known harness).'),
    experimental: z.boolean().optional().describe('Whether this model is gated behind FACTORY_EXPERIMENTAL.'),
  })
  .strict()
  .describe('A single model registry entry.');

const ModelPinsV2Schema = z
  .object({
    plan: z.string().optional().describe('Model id pinned for the PLAN phase.'),
    planFallback: z.string().optional().describe('Model id used as PLAN fallback on failure.'),
    build: z.string().optional().describe('Model id pinned for the BUILD phase.'),
    buildFallback: z
      .string()
      .optional()
      .describe('Model id used as BUILD fallback on failure (must be Codex-capable).'),
    checker: z.string().optional().describe('Model id pinned for the CHECK phase.'),
    triage: z.string().optional().describe('Model id pinned for triage.'),
  })
  .strict()
  .default({})
  .describe('Per-phase model pin overrides.');

const ProvidersV2Schema = z
  .object({
    anthropic: z.boolean().optional().describe('Whether the Anthropic provider is enabled.'),
    openai: z.boolean().optional().describe('Whether the OpenAI/Codex provider is enabled.'),
    ollama: z.boolean().optional().describe('Whether the local Ollama provider is enabled.'),
  })
  .strict()
  .default({})
  .describe('Provider enable/disable flags.');

const FailoverV2Schema = z
  .object({
    triggers: z
      .array(z.string())
      .default(['rate_limit', 'usage_cap', 'timeout', 'error', 'empty_response'])
      .describe('Reasons that trigger a model failover.'),
    maxRetries: z.number().int().positive().default(2).describe('Maximum failover retries before escalating.'),
    cooldownMs: z.number().positive().default(5000).describe('Cooldown between failover retries, in milliseconds.'),
    escalateAfterTierExhausted: z
      .boolean()
      .default(true)
      .describe('Whether to escalate once every model in a tier has failed.'),
  })
  .strict()
  .describe('Model failover policy.');

const ModelsSectionV2Schema = z
  .object({
    registry: z
      .record(z.string(), ModelDefV2Schema)
      .default({})
      .describe('Model registry overlay, merged over the packaged registry by a later issue.'),
    tiers: z.record(z.string(), z.array(z.string())).default({}).describe('Tier name to ordered model id list.'),
    pins: ModelPinsV2Schema,
    providers: ProvidersV2Schema,
    failover: FailoverV2Schema.optional().describe(
      'Failover policy overlay; absent means the packaged v1 failover block applies.',
    ),
  })
  .strict()
  .superRefine((s, ctx) => {
    for (const [name, def] of Object.entries(s.registry)) {
      if (def.harness !== undefined && !KNOWN_HARNESS_IDS.includes(def.harness)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['registry', name, 'harness'],
          message: `Model '${name}' declares unknown harness '${def.harness}' (known harnesses: ${KNOWN_HARNESS_IDS.join(', ')})`,
        });
      }
    }
  })
  .default({ registry: {}, tiers: {}, pins: {}, providers: {} })
  .describe('Model registry, tiers, pins, providers, and failover policy.');

// ---------- Routes ----------

const RouteDefV2Schema = z
  .object({
    tier: z.string().describe('Tier name this route resolves to.'),
    requires: z.string().optional().describe('Capability required for a model to serve this route.'),
  })
  .strict()
  .describe('A single route definition.');

const RoutesSectionV2Schema = z
  .record(z.string(), RouteDefV2Schema)
  .default({})
  .describe('Route name to route definition overlay.');

// ---------- Run ----------

const RunSectionV2Schema = z
  .object({
    timeouts: z
      .object({
        planSeconds: z.number().positive().default(1800).describe('PLAN phase timeout, in seconds.'),
        buildSeconds: z.number().positive().default(7200).describe('BUILD phase timeout, in seconds.'),
        checkSeconds: z.number().positive().default(1800).describe('CHECK phase timeout, in seconds.'),
        mergePollSeconds: z.number().positive().default(120).describe('Merge poll interval, in seconds.'),
        approvalSeconds: z.number().positive().default(1800).describe('Plan approval wait timeout, in seconds.'),
      })
      .strict()
      .default({
        planSeconds: 1800,
        buildSeconds: 7200,
        checkSeconds: 1800,
        mergePollSeconds: 120,
        approvalSeconds: 1800,
      })
      .describe('Per-phase timeouts.'),
    merge: z
      .object({ auto: z.boolean().default(false).describe('Whether to auto-merge ready PRs.') })
      .strict()
      .default({ auto: false })
      .describe('Merge behavior.'),
    worktree: z
      .object({
        prefix: z.string().default('ship-it/').describe('Branch name prefix for lane worktrees.'),
        parent: z.string().default('../').describe('Parent directory for lane worktrees.'),
        gcTtlDays: z.number().positive().default(7).describe('Days before a stale worktree is garbage collected.'),
        autoGcOnRun: z.boolean().default(true).describe('Whether to run worktree GC automatically on each run.'),
      })
      .strict()
      .default({ prefix: 'ship-it/', parent: '../', gcTtlDays: 7, autoGcOnRun: true })
      .describe('Worktree lifecycle settings.'),
    ci: z
      .object({ skip: z.boolean().default(false).describe('Whether to skip waiting for CI before merging.') })
      .strict()
      .default({ skip: false })
      .describe('CI wait behavior.'),
    planApproval: z
      .object({ enabled: z.boolean().default(false).describe('Whether PLAN output requires human approval.') })
      .strict()
      .default({ enabled: false })
      .describe('Plan approval gate.'),
    sandbox: z
      .object({
        enabled: z.boolean().default(true).describe('Whether BUILD/CHECK commands run in a network sandbox.'),
        network: z
          .object({
            allow: z
              .array(z.string())
              .default(['api.anthropic.com', 'github.com'])
              .describe('Allowed network destinations inside the sandbox.'),
          })
          .strict()
          .default({ allow: ['api.anthropic.com', 'github.com'] })
          .describe('Sandbox network policy.'),
        resources: z
          .object({
            cpuMs: z
              .number()
              .positive()
              .default(300000)
              .describe('CPU time budget inside the sandbox, in milliseconds.'),
            memMb: z.number().positive().default(4096).describe('Memory budget inside the sandbox, in megabytes.'),
          })
          .strict()
          .default({ cpuMs: 300000, memMb: 4096 })
          .describe('Sandbox resource limits.'),
      })
      .strict()
      .default({
        enabled: true,
        network: { allow: ['api.anthropic.com', 'github.com'] },
        resources: { cpuMs: 300000, memMb: 4096 },
      })
      .describe('Sandbox policy for BUILD/CHECK commands.'),
    environment: z
      .object({
        ports: z
          .object({
            enabled: z.boolean().default(true).describe('Whether the port-lease registry is used.'),
            range: z
              .tuple([z.number().int().min(1024).max(65535), z.number().int().min(1024).max(65535)])
              .default([3100, 3999])
              .describe('Leaseable port range, as [low, high].'),
          })
          .strict()
          .refine((p) => p.range[0] <= p.range[1], { message: 'ports.range must be [low, high]' })
          .default({ enabled: true, range: [3100, 3999] })
          .describe('Port-lease registry settings.'),
        processGroups: z
          .object({
            graceMs: z
              .number()
              .int()
              .positive()
              .default(5000)
              .describe('Grace period before killing a process group, in milliseconds.'),
          })
          .strict()
          .default({ graceMs: 5000 })
          .describe('Process group teardown settings.'),
        proxy: z
          .object({
            enabled: z.boolean().default(false).describe('Whether the lane reverse proxy is enabled.'),
            port: z.number().int().min(1).max(65535).default(80).describe('Lane reverse proxy port.'),
            domain: z.string().default('factory.localhost').describe('Lane reverse proxy base domain.'),
          })
          .strict()
          .default({ enabled: false, port: 80, domain: 'factory.localhost' })
          .describe('Lane reverse proxy settings.'),
      })
      .strict()
      .default({
        ports: { enabled: true, range: [3100, 3999] },
        processGroups: { graceMs: 5000 },
        proxy: { enabled: false, port: 80, domain: 'factory.localhost' },
      })
      .describe('Lane environment settings: ports, process groups, and proxy.'),
    failover: z
      .object({
        enabled: z.boolean().default(true).describe('Whether automatic provider failover is enabled.'),
        cooldownMinutes: z
          .number()
          .positive()
          .default(30)
          .describe('Cooldown before retrying a failed provider, in minutes.'),
        fallbackModel: z
          .string()
          .default('claude-sonnet-5')
          .describe('Model id to fall back to when providers fail over.'),
      })
      .strict()
      .default({ enabled: true, cooldownMinutes: 30, fallbackModel: 'claude-sonnet-5' })
      .describe('Automatic provider failover policy.'),
    kpis: z
      .object({
        defectWindowDays: z
          .number()
          .int()
          .positive()
          .default(14)
          .describe('Lookback window for defect-rate KPIs, in days.'),
      })
      .strict()
      .default({ defectWindowDays: 14 })
      .describe('KPI computation settings.'),
  })
  .strict()
  .default({
    timeouts: {
      planSeconds: 1800,
      buildSeconds: 7200,
      checkSeconds: 1800,
      mergePollSeconds: 120,
      approvalSeconds: 1800,
    },
    merge: { auto: false },
    worktree: { prefix: 'ship-it/', parent: '../', gcTtlDays: 7, autoGcOnRun: true },
    ci: { skip: false },
    planApproval: { enabled: false },
    sandbox: {
      enabled: true,
      network: { allow: ['api.anthropic.com', 'github.com'] },
      resources: { cpuMs: 300000, memMb: 4096 },
    },
    environment: {
      ports: { enabled: true, range: [3100, 3999] },
      processGroups: { graceMs: 5000 },
      proxy: { enabled: false, port: 80, domain: 'factory.localhost' },
    },
    failover: { enabled: true, cooldownMinutes: 30, fallbackModel: 'claude-sonnet-5' },
    kpis: { defectWindowDays: 14 },
  })
  .describe(
    'Factory run settings: timeouts, merge, worktree, ci, plan approval, sandbox, environment, failover, kpis.',
  );

// ---------- Budget ----------

const BudgetSectionV2Schema = z
  .object({
    usageCapUsd: z.number().positive().default(227).describe('Total run usage cap, in USD.'),
    perIssueCapUsd: z.number().positive().optional().describe('Per-issue usage cap, in USD.'),
    costTracking: z
      .object({
        enabled: z.boolean().default(true).describe('Whether cost tracking is enabled.'),
        logFile: z.string().default('.factory/costs.jsonl').describe('Path to the cost-tracking log file.'),
      })
      .strict()
      .default({ enabled: true, logFile: '.factory/costs.jsonl' })
      .describe('Cost tracking settings.'),
    efficiency: z
      .object({
        fastPath: z.boolean().default(false).describe('Whether to trade exploration/retries for bounded work.'),
        maxReworkRounds: z.number().int().min(0).max(3).default(1).describe('Maximum checker rework rounds.'),
      })
      .strict()
      .default({ fastPath: false, maxReworkRounds: 1 })
      .describe('Efficiency policy: fast path and rework bounds.'),
  })
  .strict()
  .default({
    usageCapUsd: 227,
    costTracking: { enabled: true, logFile: '.factory/costs.jsonl' },
    efficiency: { fastPath: false, maxReworkRounds: 1 },
  })
  .describe('Budget and cost-tracking settings.');

// ---------- Intake ----------

const IntakeSectionV2Schema = z
  .object({
    ingest: z
      .object({
        enabled: z.boolean().default(false).describe('Whether issue ingest is enabled.'),
        label: z.string().default('ready').describe('GitHub label that marks an issue ready for ingest.'),
        lane: z.string().default('auto').describe('Lane assignment strategy for ingested issues.'),
        maxPerCycle: z.number().int().positive().default(20).describe('Maximum issues ingested per cycle.'),
      })
      .strict()
      .default({ enabled: false, label: 'ready', lane: 'auto', maxPerCycle: 20 })
      .describe('Issue ingest settings.'),
    discovery: z
      .object({
        enabled: z.boolean().default(true).describe('Whether backlog discovery is enabled.'),
        schedule: z.enum(['weekly', 'daily', 'manual']).default('weekly').describe('Discovery run schedule.'),
        maxCandidates: z.number().int().positive().default(5).describe('Maximum candidate issues discovered per run.'),
      })
      .strict()
      .default({ enabled: true, schedule: 'weekly', maxCandidates: 5 })
      .describe('Backlog discovery settings.'),
    filing: z
      .object({
        enabled: z.boolean().default(true).describe('Whether automatic bug filing is enabled.'),
        excludeReasons: z
          .array(z.string())
          .default(['rate_limit', 'usage_cap', 'timeout', 'verify_failed'])
          .describe('Failure reasons excluded from automatic filing.'),
        repeatThreshold: z.number().int().positive().default(3).describe('Repeat failures required before filing.'),
        maxPerRun: z.number().int().positive().default(5).describe('Maximum issues filed per run.'),
        maxPerDay: z.number().int().positive().default(20).describe('Maximum issues filed per day.'),
        selfFixLabel: z.string().default('no-auto-merge').describe('Label applied to self-fix issues.'),
        bugLabels: z.array(z.string()).default(['bug']).describe('Labels applied to filed bug issues.'),
        sensitivePaths: z
          .array(z.string())
          .default(['packages/core/', 'packages/config/', 'packages/cli/', 'scripts/', '.github/'])
          .describe('Paths whose failures are treated as sensitive when filing.'),
      })
      .strict()
      .default({
        enabled: true,
        excludeReasons: ['rate_limit', 'usage_cap', 'timeout', 'verify_failed'],
        repeatThreshold: 3,
        maxPerRun: 5,
        maxPerDay: 20,
        selfFixLabel: 'no-auto-merge',
        bugLabels: ['bug'],
        sensitivePaths: ['packages/core/', 'packages/config/', 'packages/cli/', 'scripts/', '.github/'],
      })
      .describe('Automatic bug filing settings.'),
  })
  .strict()
  .default({
    ingest: { enabled: false, label: 'ready', lane: 'auto', maxPerCycle: 20 },
    discovery: { enabled: true, schedule: 'weekly', maxCandidates: 5 },
    filing: {
      enabled: true,
      excludeReasons: ['rate_limit', 'usage_cap', 'timeout', 'verify_failed'],
      repeatThreshold: 3,
      maxPerRun: 5,
      maxPerDay: 20,
      selfFixLabel: 'no-auto-merge',
      bugLabels: ['bug'],
      sensitivePaths: ['packages/core/', 'packages/config/', 'packages/cli/', 'scripts/', '.github/'],
    },
  })
  .describe('Intake settings: ingest, discovery, and filing.');

// ---------- Constitution ----------

const ConstitutionSectionV2Schema = z
  .object({
    path: z.string().default('constitutions/').describe('Path to the constitutions directory.'),
  })
  .strict()
  .default({ path: 'constitutions/' })
  .describe('Constitution location settings.');

// ---------- Notifications ----------

const NotificationsSectionV2Schema = z
  .object({
    onShip: z.boolean().default(true).describe('Whether to notify when an issue ships.'),
    onFail: z.boolean().default(true).describe('Whether to notify when a phase fails.'),
    onEscalate: z.boolean().default(true).describe('Whether to notify when an issue escalates.'),
    onPark: z.boolean().default(true).describe('Whether to notify when an issue is parked.'),
    onMerge: z.boolean().default(true).describe('Whether to notify when a PR merges.'),
  })
  .strict()
  .default({ onShip: true, onFail: true, onEscalate: true, onPark: true, onMerge: true })
  .describe('Notification settings.');

// ---------- Root schema ----------

export const FactoryConfigV2Schema = z
  .object({
    $schema: z.string().optional().describe('Optional JSON Schema URL for editor tooling; ignored by the factory.'),
    version: z.literal(2).describe('Config format version. 2 = unified sparse-overlay config.'),
    models: ModelsSectionV2Schema,
    routes: RoutesSectionV2Schema,
    run: RunSectionV2Schema,
    budget: BudgetSectionV2Schema,
    intake: IntakeSectionV2Schema,
    constitution: ConstitutionSectionV2Schema,
    notifications: NotificationsSectionV2Schema,
  })
  .strict()
  .describe('Unified v2 factory configuration. A sparse overlay: {"version": 2} alone is complete and valid.');

export type FactoryConfigV2 = z.infer<typeof FactoryConfigV2Schema>;

// ---------- Loading ----------

/** One and only parse site for v2 config. Throws naming sourcePath on schema violation. */
export function parseConfigV2(raw: unknown, sourcePath: string): FactoryConfigV2 {
  const result = FactoryConfigV2Schema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new Error(`Invalid ${sourcePath}: ${issues}`);
  }
  return result.data;
}

/** Read + validate a v2 config file at an explicit path. Throws on unreadable/malformed JSON (naming
 *  the path) or a schema violation. */
export function loadConfigV2(path: string): FactoryConfigV2 {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err: any) {
    throw new Error(`Failed to parse ${path}: ${err.message}`);
  }
  return parseConfigV2(raw, path);
}

/** Read `<repoRoot>/.factory/config.json` as v2. Returns `null` when the file is absent OR is
 *  not version 2 (a v1 file, handled by `loadRepoConfig`). Throws loudly on a malformed/invalid
 *  v2 file. */
export function loadRepoConfigV2(repoRoot: string): FactoryConfigV2 | null {
  const path = getFactoryPaths(repoRoot).config;
  if (!existsSync(path)) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err: any) {
    throw new Error(`Failed to parse ${path}: ${err.message}`);
  }

  if (typeof raw !== 'object' || raw === null || (raw as { version?: unknown }).version !== 2) {
    return null;
  }
  return parseConfigV2(raw, path);
}

/** JSON Schema (draft 2020-12, includes `$schema`) for `FactoryConfigV2Schema`; descriptions come
 *  from `.describe()`. */
export function factoryConfigV2JsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(FactoryConfigV2Schema, { io: 'input' }) as Record<string, unknown>;
}
