// packages/core/src/config/v2.ts — Unified versioned (v2) factory config schema
//
// One zod schema that unifies the full configuration surface currently split
// across three packaged files (models.json, routes.json, factory.json) plus the
// per-repo `.factory/config.json` overlay. Every section is optional and carries
// zod defaults, so a `.factory/config.json` containing only `{"version": 2}`
// validates and loads as a complete config with all defaults applied.
//
// This is ADDITIVE. The v1 schemas and loaders in ./index.ts and ./repo.ts are
// untouched and keep working. The in-memory v1->v2 migration adapter and the
// `factory migrate` command are a separate issue (#715 is the schema itself).
//
// Field documentation lives in `.describe()` calls on the schema — there are no
// `"comment"` pseudo-doc fields in v2. `factoryConfigV2JsonSchema()` emits a
// JSON Schema (draft 2020-12, with `$schema`) generated from this schema so the
// descriptions are the single source of truth for both validation and docs.
//
// NOTE on defaults: nested section defaults use `.prefault({})`, not
// `.default({})`. In zod v4 `.default(v)` substitutes `v` verbatim without
// re-parsing, so a bare `.default({})` on a section would NOT fill that section's
// own field defaults. `.prefault({})` feeds `{}` back through the schema, so a
// missing section expands to all of its inner defaults (recursively). Leaf
// primitives and concrete-value records/arrays keep `.default(...)`.

import { readFileSync } from 'node:fs';

import { z } from 'zod';

// ---------- Models ----------

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
    harness: z
      .string()
      .optional()
      .describe('Harness id that drives this model (claude-cli, codex-cli, ollama-http, ...).'),
    codex: z.boolean().optional().describe('Marks the model eligible for the build_codex route.'),
    experimental: z.boolean().optional().describe('Requires FACTORY_EXPERIMENTAL=1 to be routable.'),
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
  })
  .describe('Per-phase model pins. Each overrides the default tier resolution for that phase.');

const ProvidersSchema = z
  .object({
    anthropic: z.boolean().optional().describe('Enable/disable Anthropic models (default: enabled).'),
    openai: z.boolean().optional().describe('Enable/disable OpenAI/Codex models (default: enabled).'),
    ollama: z.boolean().optional().describe('Enable/disable local Ollama models (default: enabled).'),
  })
  .describe('Provider on/off switches. Omitting a provider leaves it enabled.');

const ModelsSectionSchema = z
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
    providers: ProvidersSchema.prefault({}),
    failover: ModelFailoverSchema.prefault({}),
    routingRules: z
      .record(z.string(), z.unknown())
      .default({})
      .describe('Conditional routing hints (codex_available, ollama_available, byok_active, ...).'),
  })
  .describe('Model registry, tiers, per-phase pins, provider switches, and failover behavior.');

// ---------- Routes ----------

const RouteSchema = z
  .object({
    tier: z.string().describe('Tier this task type resolves against.'),
    description: z.string().describe('What this route is for.'),
    requires: z.string().optional().describe('Harness/capability the route requires (e.g. codex, claude, opencode).'),
  })
  .describe('One task-type -> tier route.');

const RoutesSectionSchema = z
  .record(z.string(), RouteSchema)
  .default({})
  .describe('Task-type to model-tier routing. The router resolves each route’s tier to the first available model.');

// ---------- Run ----------

const MergeSchema = z
  .object({
    auto: z.boolean().default(false).describe('Autonomous squash-merge (also gated by FACTORY_MERGE=1).'),
    admin: z
      .boolean()
      .default(false)
      .describe('Bypass unmet merge requirements with GitHub admin privileges (FACTORY_MERGE_ADMIN=1).'),
  })
  .describe('Merge/land behavior for shipped PRs.');

const TimeoutsSchema = z
  .object({
    plan_seconds: z.number().default(1800).describe('PLAN phase timeout in seconds.'),
    build_seconds: z.number().default(7200).describe('BUILD phase timeout in seconds.'),
    check_seconds: z.number().default(1800).describe('CHECK phase timeout in seconds.'),
    merge_poll_seconds: z.number().default(120).describe('Interval in seconds between merge-readiness polls.'),
    approval_seconds: z.number().default(1800).describe('How long to wait for operator approval before timing out.'),
  })
  .describe('Per-phase timeouts.');

const SandboxSchema = z
  .object({
    enabled: z.boolean().default(true).describe('Contain agentic build runs (disable per-run with FACTORY_SANDBOX=0).'),
    network: z
      .object({
        allow: z
          .array(z.string())
          .default(['api.anthropic.com', 'github.com'])
          .describe('Allowed egress hosts. Empty denies all egress; non-empty leaves egress open (v1 limitation).'),
      })
      .prefault({}),
    resources: z
      .object({
        cpuMs: z.number().positive().default(300_000).describe('CPU time budget in milliseconds.'),
        memMb: z.number().positive().default(4096).describe('Memory budget in megabytes.'),
      })
      .prefault({}),
  })
  .describe('Sandbox containment for build runs.');

const WorktreeSchema = z
  .object({
    prefix: z.string().default('ship-it/').describe('Branch/worktree name prefix for factory work.'),
    parent: z.string().default('../').describe('Directory (relative to the repo) where worktrees are created.'),
    gcTtlDays: z.number().default(7).describe('Age in days after which stale worktrees are garbage-collected.'),
    autoGcOnRun: z.boolean().default(true).describe('Garbage-collect stale worktrees at the start of each run.'),
  })
  .describe('Git worktree management for parallel lanes.');

const EnvironmentSchema = z
  .object({
    ports: z
      .object({
        enabled: z
          .boolean()
          .default(true)
          .describe('Lease a unique app port per lane (disable with FACTORY_ENV_PORTS=0).'),
        range: z
          .tuple([z.number().int().min(1024).max(65535), z.number().int().min(1024).max(65535)])
          .default([3100, 3999])
          .describe('Inclusive [low, high] port range to lease from.'),
      })
      .refine((p) => p.range[0] <= p.range[1], { message: 'ports.range must be [low, high]' })
      .prefault({}),
    processGroups: z
      .object({
        graceMs: z
          .number()
          .int()
          .positive()
          .default(5000)
          .describe('Grace period in milliseconds between SIGTERM and SIGKILL when sweeping a lane.'),
      })
      .prefault({}),
    proxy: z
      .object({
        enabled: z
          .boolean()
          .default(false)
          .describe('Loopback reverse proxy giving each lane a stable URL (FACTORY_PROXY=1/0).'),
        port: z.number().int().min(1).max(65535).default(80).describe('Port the proxy binds on 127.0.0.1.'),
        domain: z.string().default('factory.localhost').describe('Base domain for per-lane URLs (<lane>.<domain>).'),
      })
      .prefault({}),
  })
  .describe('Per-lane runtime environment: app ports, process-group teardown, and the optional reverse proxy.');

const AutoFailoverSchema = z
  .object({
    enabled: z.boolean().default(true).describe('Supervisor circuit breaker for cross-harness build failover.'),
    cooldownMinutes: z
      .number()
      .positive()
      .default(30)
      .describe('How long a tripped provider is skipped (FACTORY_FAILOVER_COOLDOWN_MINUTES).'),
    fallbackModel: z
      .string()
      .default('claude-sonnet-5')
      .describe('Model the tripping lane falls over to (FACTORY_FAILOVER_MODEL).'),
  })
  .describe('Supervisor-level circuit breaker: on a quota trip, skip the failing provider for a cooldown window.');

const EfficiencySchema = z
  .object({
    fastPath: z.boolean().default(false).describe('Trade expensive exploration for a bounded PLAN path.'),
    maxReworkRounds: z.number().int().min(0).max(3).default(1).describe('Maximum checker-rework retries per issue.'),
    perIssueCapUsd: z
      .number()
      .positive()
      .optional()
      .describe('Hard USD cap per issue (in addition to the run-wide cap).'),
  })
  .describe('Opt-in controls that bound exploration and retries.');

const RunSectionSchema = z
  .object({
    merge: MergeSchema.prefault({}),
    timeouts: TimeoutsSchema.prefault({}),
    sandbox: SandboxSchema.prefault({}),
    worktree: WorktreeSchema.prefault({}),
    environment: EnvironmentSchema.prefault({}),
    autoFailover: AutoFailoverSchema.prefault({}),
    efficiency: EfficiencySchema.prefault({}),
    ci: z
      .object({
        skip: z
          .boolean()
          .default(false)
          .describe('Skip waiting for GitHub Actions CI before merging (FACTORY_SKIP_CI=1).'),
      })
      .prefault({})
      .describe('CI gating before merge.'),
    planApproval: z
      .object({
        enabled: z
          .boolean()
          .default(false)
          .describe('Pause after PLAN freezes the spec and wait for operator approval before BUILD.'),
      })
      .prefault({})
      .describe('Optional pre-code approval gate.'),
    branchPrefix: z
      .string()
      .default('ship-it')
      .describe('Branch-name prefix shared by ship, land, and ingest (FACTORY_BRANCH_PREFIX).'),
    byok: z
      .object({
        enabled: z
          .boolean()
          .default(false)
          .describe('Bring-your-own-key mode: only use models whose API keys are present in env.'),
      })
      .prefault({})
      .describe('BYOK gating.'),
  })
  .describe('Run-time behavior: merge, timeouts, sandbox, worktrees, environment, and failover.');

// ---------- Budget ----------

const BudgetSectionSchema = z
  .object({
    usageCapUsd: z.number().positive().default(227).describe('Run-wide spend cap in USD (FACTORY_USAGE_CAP).'),
    costTracking: z
      .object({
        enabled: z.boolean().default(true).describe('Log per-task token usage and cost.'),
        logFile: z.string().default('.factory/costs.jsonl').describe('Path to the cost log (JSONL).'),
      })
      .prefault({})
      .describe('Cost tracking.'),
    kpis: z
      .object({
        defectWindowDays: z
          .number()
          .int()
          .positive()
          .default(14)
          .describe('Post-merge defect window in days (FACTORY_DEFECT_WINDOW_DAYS).'),
      })
      .prefault({})
      .describe('KPI scoring windows.'),
  })
  .describe('Spend caps, cost tracking, and KPI windows.');

// ---------- Intake ----------

const IntakeSectionSchema = z
  .object({
    ingest: z
      .object({
        enabled: z
          .boolean()
          .default(false)
          .describe('Always-on auto-ingest of labeled issues (FACTORY_AUTO_INGEST=1/0).'),
        label: z.string().default('ready').describe('Issue label that marks an issue ready to ingest.'),
        lane: z.string().default('auto').describe('Lane new issues are appended under.'),
        maxPerCycle: z.number().int().positive().default(20).describe('Maximum issues ingested per supervise cycle.'),
      })
      .prefault({})
      .describe('Auto-ingest of labeled GitHub issues.'),
    discovery: z
      .object({
        enabled: z.boolean().default(true).describe('Scheduled read-only scan proposing candidate ideas.'),
        schedule: z.enum(['weekly', 'daily', 'manual']).default('weekly').describe('How often discovery runs.'),
        maxCandidates: z.number().int().positive().default(5).describe('Maximum ranked candidates proposed per scan.'),
      })
      .prefault({})
      .describe('Idea discovery from product signals (no GitHub writes).'),
    filing: z
      .object({
        enabled: z.boolean().default(true).describe('Auto-file self-defects discovered during runs.'),
        excludeReasons: z
          .array(z.string())
          .default(['rate_limit', 'usage_cap', 'timeout', 'verify_failed'])
          .describe('Park reasons never filed unless the same fingerprint repeats.'),
        repeatThreshold: z
          .number()
          .int()
          .positive()
          .default(3)
          .describe('Repeats of an excluded fingerprint before it is filed anyway.'),
        maxPerRun: z.number().int().positive().default(5).describe('Maximum new bugs filed per run.'),
        maxPerDay: z.number().int().positive().default(20).describe('Maximum new bugs filed per day.'),
        selfFixLabel: z
          .string()
          .default('no-auto-merge')
          .describe('Label applied to factory-internal bugs so the merge path requires human approval.'),
        bugLabels: z.array(z.string()).default(['bug']).describe('Labels applied to filed bugs.'),
        sensitivePaths: z
          .array(z.string())
          .default(['packages/core/', 'packages/config/', 'packages/cli/', 'scripts/', '.github/'])
          .describe('Paths whose changes are treated as sensitive.'),
      })
      .prefault({})
      .describe('Guardrails for auto-filing self-defects.'),
  })
  .describe('Work intake: ingest, discovery, and self-defect filing.');

// ---------- Constitution & notifications ----------

const ConstitutionSectionSchema = z
  .object({
    path: z
      .string()
      .default('constitutions/')
      .describe('Path (repo-relative or packaged) to the product constitution markdown.'),
  })
  .describe('Product constitution location.');

const NotificationsSectionSchema = z
  .record(z.string(), z.boolean())
  .default({ on_ship: true, on_fail: true, on_escalate: true, on_park: true, on_merge: true })
  .describe('Event -> on/off notification switches (on_ship, on_fail, on_escalate, on_park, on_merge, ...).');

// ---------- Top-level v2 schema ----------

export const FactoryConfigV2Schema = z
  .object({
    version: z.literal(2).describe('Config schema version. Must be 2.'),
    models: ModelsSectionSchema.prefault({}),
    routes: RoutesSectionSchema,
    run: RunSectionSchema.prefault({}),
    budget: BudgetSectionSchema.prefault({}),
    intake: IntakeSectionSchema.prefault({}),
    constitution: ConstitutionSectionSchema.prefault({}),
    notifications: NotificationsSectionSchema,
  })
  .describe(
    'Unified Software Factory configuration (v2). Every section is optional with defaults; ' +
      'a `.factory/config.json` of `{"version": 2}` is a complete, valid config.',
  );

export type FactoryConfigV2 = z.infer<typeof FactoryConfigV2Schema>;

// ---------- Loaders ----------

/** Validate and normalize a raw (already-parsed) v2 config object, applying all
 *  section defaults. Throws a descriptive, path-annotated error on any violation. */
export function parseV2Config(raw: unknown): FactoryConfigV2 {
  const result = FactoryConfigV2Schema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new Error(`Invalid v2 config: ${issues}`);
  }
  return result.data;
}

/** Read and validate a v2 config file (e.g. `.factory/config.json`). A file
 *  containing only `{"version": 2}` loads as a complete config with defaults. */
export function loadV2Config(path: string): FactoryConfigV2 {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err: any) {
    throw new Error(`Failed to parse ${path}: ${err.message}`);
  }
  try {
    return parseV2Config(raw);
  } catch (err: any) {
    throw new Error(err.message.replace('Invalid v2 config:', `Invalid ${path}:`));
  }
}

// ---------- JSON Schema generation ----------

/** Generate a JSON Schema (draft 2020-12, with `$schema`) from the v2 zod schema.
 *  Field descriptions come from the `.describe()` annotations, so the schema is
 *  the single source of truth for both validation and generated documentation.
 *  `io: 'input'` renders defaulted fields as optional (the on-disk overlay shape). */
export function factoryConfigV2JsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(FactoryConfigV2Schema, { io: 'input' }) as Record<string, unknown>;
}
