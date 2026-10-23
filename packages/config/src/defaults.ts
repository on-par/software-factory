// packages/config/src/defaults.ts — the shipped factory defaults, as TypeScript.
//
// This file is the ONLY copy of these values. It replaced models.json /
// routes.json / factory.json (#716): tsc used to emit a second copy of those
// into dist/, and the two load paths could disagree about which was
// authoritative. Do not add JSON back to this package.
//
// Declares its own structural interfaces rather than importing zod or
// @on-par/factory-core: this package is zero-dependency and config <- core
// is the dependency direction (AGENTS.md), so the zod schemas in
// packages/core/src/config/index.ts stay the single runtime shape authority.

export interface ModelDefaults {
  provider: 'anthropic' | 'openai' | 'ollama' | 'deepseek' | 'custom';
  tier: string | string[];
  costPerMtokInput: number;
  costPerMtokOutput: number;
  costPerMtokCachedInput?: number;
  contextWindow: number;
  capabilities: string[];
  envKey: string | null;
  claudeFlag?: string;
  providerModel?: string;
  providerOptions?: Record<string, unknown>;
  /** Approved Anthropic-compatible intermediary base URL (https) for the claude-cli harness; needs envKey (#2906, ADR-0163). */
  endpoint?: string;
  codex?: boolean;
  codexFlag?: string;
  harness?: string;
  experimental?: boolean;
  /** Provider may use prompts for training. Never placed in a tier, reachable only by an explicit pin (#2899). */
  trainsOnPrompts?: boolean;
}

export interface ModelsDefaults {
  version: number;
  models: Record<string, ModelDefaults>;
  tiers: Record<string, string[]>;
  /** Per role: subscription providers in failover order as model ids, one per provider (claude, codex, opencode-go) (#3334). Derived from the tiers with opencode-go last. OpenCode Zen (opencode/) models are never listed. */
  providerOrder: Record<'boss' | 'worker' | 'checker' | 'triage', string[]>;
  /** `triggers` are provider failure kinds (rate_limit, unavailable, auth) that fall back to the next model at the same provider. */
  failover: { triggers: string[]; maxRetries: number; cooldownMs: number };
  routingRules: Record<string, unknown>;
}

export type { RouteDefaults, RoutesDefaults } from './defaults-routes.js';
export { defaultRoutesConfig } from './defaults-routes.js';

export interface FactoryDefaults {
  version: number;
  paths: { constitutions: string; checkers: string; plans: string; logs: string; events: string; constitution: string };
  timeouts: {
    plan_seconds: number;
    build_seconds: number;
    check_seconds: number;
    merge_poll_seconds: number;
    approval_seconds: number;
    tests_seconds: number;
    compile_seconds: number;
  };
  pr: { footer: string };
  merge: { auto: boolean; comment: string };
  worktree: { parent: string; comment: string; gcTtlDays: number; autoGcOnRun: boolean };
  byok: { enabled: boolean; comment: string };
  notifications: Record<string, boolean>;
  cost_tracking: { enabled: boolean; log_file: string; comment: string };
  // ci/sweep/plan_approval/kpis/sandbox/discovery/filing/ingest/environment ports+proxy/auto_failover.comment are
  // schema-optional (FactoryConfigSchema declares them z.string().optional()), but this package keeps them as
  // data anyway: dropping them would desync loadFactoryConfig()'s no-path output from what the deleted
  // factory.json produced, breaking the byte-identical behavior contract (#716).
  kpis: { defectWindowDays: number; comment?: string };
  ci: { skip: boolean; comment?: string };
  sweep: { heartbeatFile?: string; loopIntervalSeconds: number; staleThresholdMultiplier: number; comment?: string };
  plan_approval: { enabled: boolean; comment?: string };
  /** PLAN design-artifact gates (#1819). */
  design: { blockUnresolvedRegressions: boolean };
  /** PLAN readiness enrichment (#2385). updateIssueBody: false keeps enrichment in memory only. */
  readiness: { updateIssueBody: boolean };
  /** BUILD policy (#1867). publishFromBuild: true lets the claude BUILD worker push and open a PR before CHECK; default false = commit-only, SHIP publishes. contextCeiling is the per-harness Codex auto-compact token limit for BUILD/rework, 0 = off (#3327). */
  build: { publishFromBuild: boolean; contextCeiling: Record<string, number> };
  /** Size gate policy (ADR-0147). file: gates file child issues / park (ADR-0043); slice: keep an oversized issue whole and ship it as slice PRs, never filing issues (ADR-0156); off: skip both gates. maxSlices (1-20): cap on a not-yet-started slice plan; over it the plan is recorded and the run parks. tokenBudget / maxFiles (#3350): the post-plan gate splits only when the plan's estimated tokens exceed tokenBudget or its changed files exceed maxFiles; a plan changing 3 files or fewer never splits. */
  sizeGate: { mode: 'file' | 'slice' | 'off' | 'stack'; maxSlices: number; tokenBudget: number; maxFiles: number };
  sandbox: {
    enabled: boolean;
    runtime: 'auto' | 'sandbox-exec' | 'firejail' | 'docker-sandbox' | 'none';
    codexFullAccessTasks?: string[];
    /** Extra directories the sandbox may write (#3454): absolute or `~/…`; not `/`, `~`, or the repo. */
    writablePaths?: string[];
    network: { allow: string[]; blockTelemetry?: boolean; mode?: 'report' | 'enforce' };
    resources: { cpuMs: number; memMb: number };
    docker?: { rolloutPercent: number };
    comment?: string;
  };
  discovery: { enabled: boolean; schedule: 'weekly' | 'daily' | 'manual'; maxCandidates: number; comment?: string };
  filing: {
    enabled: boolean;
    excludeReasons: string[];
    repeatThreshold: number;
    maxPerRun: number;
    maxPerDay: number;
    selfFixLabel: string;
    bugLabels: string[];
    sensitivePaths: string[];
    /** Repo (owner/name) that `factory feedback` files issues in. Unset: the checkout origin remote; no built-in default. */
    repo?: string;
    comment?: string;
  };
  ingest: { enabled: boolean; label: string; lane: string; maxPerCycle: number; comment?: string };
  /**
   * Issue-approval gate for claims (#1802). `trustedApprovers` lists the GitHub logins whose approval
   * counts; unset means users with admin permission on the repo (a permission-lookup failure counts
   * as untrusted). `enforce: 'warn'` only logs a missing/untrusted approval; `'enforce'` blocks the claim.
   */
  intake: { trustedApprovers?: string[]; enforce: 'warn' | 'enforce'; comment?: string };
  environment: {
    ports: { enabled: boolean; range: [number, number]; comment?: string };
    proxy: { enabled: boolean; port: number; domain: string; comment?: string };
  };
  host: {
    maxBuilds: number;
    maxAgentJobs: number;
    loadGuard: { enabled: boolean; maxLoad?: number; retrySeconds: number };
    comment?: string;
  };
  auto_failover: { enabled: boolean; cooldown_minutes: number; fallback_model: string; comment?: string };
  queue: { claim_settle_ms: number; comment?: string };
}

/** Model registry: providers, costs, capabilities, tiers and failover chains. */
export const defaultModelsConfig: ModelsDefaults = {
  version: 1,
  models: {
    /** Claude Fable 5 — most capable model, uses claude CLI subscription auth. Falls back to opus on rate-limit/usage-cap. */
    'claude-fable-5': {
      provider: 'anthropic',
      tier: 'boss',
      costPerMtokInput: 8.0,
      costPerMtokOutput: 40.0,
      contextWindow: 200000,
      capabilities: ['planning', 'design', 'architecture', 'review', 'dispute_resolution'],
      envKey: null,
      harness: 'claude-cli',
      claudeFlag: 'fable',
    },
    /** Claude Opus 5 — boss/plan model, uses claude CLI subscription auth. */
    'claude-opus-5': {
      provider: 'anthropic',
      tier: 'boss',
      costPerMtokInput: 5.0,
      costPerMtokOutput: 25.0,
      contextWindow: 200000,
      capabilities: ['planning', 'design', 'architecture', 'review', 'dispute_resolution'],
      envKey: null,
      harness: 'claude-cli',
      claudeFlag: 'claude-opus-5',
    },
    /** Claude Opus 5.5 — registered for repo pins only (not in any default tier), uses claude CLI subscription auth. */
    'claude-opus-5-5': {
      provider: 'anthropic',
      tier: 'boss',
      costPerMtokInput: 4.0,
      costPerMtokOutput: 20.0,
      contextWindow: 200000,
      capabilities: ['planning', 'design', 'architecture', 'review', 'dispute_resolution'],
      envKey: null,
      harness: 'claude-cli',
      claudeFlag: 'claude-opus-5-5',
    },
    /** Uses claude CLI subscription auth, no API key needed. */
    'claude-opus-4-8': {
      provider: 'anthropic',
      tier: 'boss',
      costPerMtokInput: 5.0,
      costPerMtokOutput: 25.0,
      contextWindow: 200000,
      capabilities: ['planning', 'design', 'architecture', 'review', 'dispute_resolution'],
      envKey: null,
      harness: 'claude-cli',
      claudeFlag: 'claude-opus-4-8',
    },
    /** Uses claude CLI subscription auth, no API key needed. */
    'claude-sonnet-5': {
      provider: 'anthropic',
      tier: ['checker', 'boss_fallback', 'worker_fallback'],
      costPerMtokInput: 3.0,
      costPerMtokOutput: 15.0,
      contextWindow: 200000,
      capabilities: ['review', 'verification', 'implementation', 'triage'],
      envKey: null,
      harness: 'claude-cli',
      claudeFlag: 'claude-sonnet-5',
    },
    /** Claude Sonnet 5.5 — registered for repo pins only (not in any default tier), uses claude CLI subscription auth. */
    'claude-sonnet-5-5': {
      provider: 'anthropic',
      tier: ['checker', 'boss_fallback', 'worker_fallback'],
      costPerMtokInput: 2.0,
      costPerMtokOutput: 10.0,
      contextWindow: 200000,
      capabilities: ['review', 'verification', 'implementation', 'triage'],
      envKey: null,
      harness: 'claude-cli',
      claudeFlag: 'claude-sonnet-5-5',
    },
    /** Codex CLI subscription auth (ChatGPT/OAuth), not an API key — do not gate availability on OPENAI_API_KEY. Explicitly pins -m gpt-5.6-sol instead of silently riding ~/.codex/config.toml's default model. */
    'gpt-5.6-sol': {
      provider: 'openai',
      tier: ['worker'],
      costPerMtokInput: 1.25,
      costPerMtokOutput: 10.0,
      contextWindow: 272000,
      capabilities: ['implementation', 'codex'],
      envKey: null,
      harness: 'codex-cli',
      codex: true,
      codexFlag: '-m gpt-5.6-sol -c model_reasoning_effort=medium',
    },
    /** Codex CLI subscription auth (ChatGPT/OAuth), not an API key — do not gate availability on OPENAI_API_KEY. Explicitly pins -m gpt-5.1-codex so failover from gpt-5.6-sol actually changes models (#415). Kept as fallback behind gpt-5.6-sol. */
    'gpt-5.1-codex': {
      provider: 'openai',
      tier: ['worker'],
      costPerMtokInput: 1.25,
      costPerMtokOutput: 10.0,
      contextWindow: 272000,
      capabilities: ['implementation', 'codex'],
      envKey: null,
      harness: 'codex-cli',
      codex: true,
      codexFlag: '-m gpt-5.1-codex -c model_reasoning_effort=high',
    },
    /** Default Codex GPT PLAN profile (#529): GPT 5.6 Terra at high reasoning effort. Codex CLI subscription auth (ChatGPT/OAuth) — do not gate on OPENAI_API_KEY. Kept at the END of tiers.boss so Claude/Ollama plan defaults are unchanged; it is the plan model whenever the GPT provider path is selected (provider filtering or an explicit pin). Distinct model_reasoning_effort per profile keeps the #415 failover-changes-config invariant. */
    'gpt-5.6-terra-high': {
      provider: 'openai',
      tier: ['boss'],
      costPerMtokInput: 1.25,
      costPerMtokOutput: 10.0,
      contextWindow: 272000,
      capabilities: ['planning', 'design', 'architecture', 'review', 'codex'],
      envKey: null,
      harness: 'codex-cli',
      codex: true,
      codexFlag: '-m gpt-5.6-terra -c model_reasoning_effort=high',
    },
    /** Default Codex GPT BUILD profile (#529): GPT 5.6 Terra at medium reasoning effort. Codex CLI subscription auth (ChatGPT/OAuth) — do not gate on OPENAI_API_KEY. First in the build_codex chain; gpt-5.6-sol and gpt-5.1-codex remain as failovers. */
    'gpt-5.6-terra-medium': {
      provider: 'openai',
      tier: ['worker'],
      costPerMtokInput: 1.25,
      costPerMtokOutput: 10.0,
      contextWindow: 272000,
      capabilities: ['implementation', 'codex'],
      envKey: null,
      harness: 'codex-cli',
      codex: true,
      codexFlag: '-m gpt-5.6-terra -c model_reasoning_effort=medium',
    },
    /** Codex GPT BUILD/CHECK profile: GPT 5.6 Luna at high reasoning effort. Codex CLI subscription auth (ChatGPT/OAuth) — do not gate on OPENAI_API_KEY. Intended for fast worker/checker lanes when the repo explicitly pins it. */
    'gpt-5.6-luna-high': {
      provider: 'openai',
      tier: ['worker', 'checker', 'triage'],
      costPerMtokInput: 1.25,
      costPerMtokOutput: 10.0,
      contextWindow: 272000,
      capabilities: ['implementation', 'verification', 'codex'],
      envKey: null,
      harness: 'codex-cli',
      codex: true,
      codexFlag: '-m gpt-5.6-luna -c model_reasoning_effort=high',
    },
    /** Opt-in Astra profile. Codex subscription auth; existing tier order stays unchanged. */
    'gpt-6-astra': {
      provider: 'openai',
      tier: ['boss', 'worker', 'checker'],
      costPerMtokInput: 10,
      costPerMtokOutput: 50,
      contextWindow: 272000,
      capabilities: ['planning', 'implementation', 'verification', 'codex'],
      envKey: null,
      harness: 'codex-cli',
      codex: true,
      codexFlag: '-m gpt-6-astra -c model_reasoning_effort=medium',
    },
    /** speculative — opt in with FACTORY_EXPERIMENTAL=1 */
    'glm-5.2': {
      provider: 'ollama',
      tier: 'worker',
      costPerMtokInput: 0.1,
      costPerMtokOutput: 0.5,
      contextWindow: 131072,
      capabilities: ['implementation', 'coding'],
      envKey: null,
      harness: 'ollama-http',
      claudeFlag: 'ollama/glm-5.2:cloud',
      experimental: true,
    },
    /** Local-only Ollama coding model for 16GB Macs. Slow is acceptable; keep concurrency low. */
    'qwen2.5-coder:14b': {
      provider: 'ollama',
      tier: ['boss', 'worker', 'checker', 'triage'],
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 32768,
      capabilities: ['planning', 'implementation', 'coding', 'review', 'verification', 'triage'],
      envKey: null,
      harness: 'ollama-http',
      providerModel: 'qwen2.5-coder:14b',
      providerOptions: {
        num_ctx: 16384,
        temperature: 0.1,
      },
    },
    /** EXPERIMENTAL quarantined spike (ADR-0003): local-only worker driving Ollama qwen3.5:9b through the schema-bound ollama-agentic harness. codex: true only marks build_codex eligibility — this model never runs 'codex exec --local-provider'; there is no codexFlag. Opt in with FACTORY_EXPERIMENTAL=1. Retire or keep after the #170 bounded-retry test and the first green local fixture run (epic #163). */
    'codex-ollama-qwen3.5:9b': {
      provider: 'ollama',
      tier: ['worker'],
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 32768,
      capabilities: ['implementation', 'coding', 'codex'],
      envKey: null,
      harness: 'ollama-agentic',
      providerModel: 'qwen3.5:9b',
      providerOptions: {
        num_ctx: 8192,
        temperature: 0.1,
      },
      codex: true,
      experimental: true,
    },
    /** Local Ollama fallback/second-opinion model; supports tools/thinking in Ollama. */
    'qwen3.5:9b': {
      provider: 'ollama',
      tier: ['worker', 'checker'],
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 65536,
      capabilities: ['implementation', 'coding', 'review', 'verification'],
      envKey: null,
      harness: 'ollama-http',
      providerModel: 'qwen3.5:9b',
      providerOptions: {
        num_ctx: 8192,
        temperature: 0.1,
      },
    },
    /** Smaller local Ollama fallback for memory-constrained runs. */
    'qwen3:8b': {
      provider: 'ollama',
      tier: ['worker', 'checker'],
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 40960,
      capabilities: ['implementation', 'coding', 'review', 'verification'],
      envKey: null,
      harness: 'ollama-http',
      providerModel: 'qwen3:8b',
      providerOptions: {
        num_ctx: 24576,
        temperature: 0.2,
      },
    },
    /** Local Ollama planning/review alternative; expect model swaps on 16GB hosts. */
    'gemma4:12b': {
      provider: 'ollama',
      tier: ['boss', 'checker'],
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 131072,
      capabilities: ['planning', 'review', 'verification', 'dispute_resolution'],
      envKey: null,
      harness: 'ollama-http',
      providerModel: 'gemma4:12b',
      providerOptions: {
        num_ctx: 32768,
        temperature: 0.2,
      },
    },
    /** speculative — opt in with FACTORY_EXPERIMENTAL=1 */
    'qwen-3.5-coder': {
      provider: 'ollama',
      tier: 'worker',
      costPerMtokInput: 0.05,
      costPerMtokOutput: 0.2,
      contextWindow: 131072,
      capabilities: ['implementation', 'coding'],
      envKey: null,
      harness: 'ollama-http',
      claudeFlag: 'ollama/qwen3.5-coder:cloud',
      experimental: true,
    },
    /** First provider added via the generic harness seam (#188). OpenCode CLI (opencode run) with provider/model id; opt in with FACTORY_EXPERIMENTAL=1. Doctor reports 'opencode CLI not found on PATH' when the CLI is missing. */
    'opencode-sonnet': {
      provider: 'custom',
      tier: ['worker'],
      costPerMtokInput: 3.0,
      costPerMtokOutput: 15.0,
      contextWindow: 200000,
      capabilities: ['implementation', 'coding'],
      envKey: null,
      harness: 'opencode',
      providerModel: 'anthropic/claude-sonnet-5',
      experimental: true,
    },
    /** Added 2026-08-12 for OpenCode Go subscriptions (OPENCODE_API_KEY env var). Served via OpenCode Go (https://opencode.ai/zen/go/v1), a distinct provider from OpenCode Zen (opencode/... prefix, pay-per-use; do not confuse the two, the same env var backs both; Zen models are refused in defaults, providerOrder and failover, #3334). Confirmed working live: `opencode run --model opencode-go/deepseek-v4-flash "..."` returns real output. Updated 2026-10-14 (#2898): DeepSeek now serves V4.1 Flash (the old `deepseek-v4-flash` name routes there). Go id `opencode-go/deepseek-v4.1-flash` per https://opencode.ai/docs/go (taken from the docs page; `opencode models opencode-go` needs a Go login); prices $0.30/$1.20 per 1M per https://opencode.ai/docs/zen (Go bills $0.15/$0.60 off-peak, $0.30/$1.20 peak), checked 2026-10-14. opt in with FACTORY_EXPERIMENTAL=1. */
    'opencode-deepseek-v4-flash': {
      provider: 'custom',
      tier: ['worker'],
      costPerMtokInput: 0.3,
      costPerMtokOutput: 1.2,
      contextWindow: 1000000,
      capabilities: ['implementation', 'coding'],
      envKey: 'OPENCODE_API_KEY',
      harness: 'opencode',
      providerModel: 'opencode-go/deepseek-v4.1-flash',
      experimental: true,
    },
    /** Added 2026-10-14 (#2898): DeepSeek V4 Pro via OpenCode Go (still served; retirement reversed 2026-09-11). Go id `opencode-go/deepseek-v4-pro` per https://opencode.ai/docs/go (taken from the docs page); prices $1.74/$3.48 per 1M per https://opencode.ai/docs/zen (Go bills $0.66/$1.98 off-peak, $1.32/$3.96 peak), checked 2026-10-14. Pin-only: in no tier. OpenCode Go is an approved zero-retention intermediary (ADR-0163). opt in with FACTORY_EXPERIMENTAL=1. */
    'opencode-deepseek-v4-pro': {
      provider: 'custom',
      tier: ['worker'],
      costPerMtokInput: 1.74,
      costPerMtokOutput: 3.48,
      contextWindow: 1000000,
      capabilities: ['implementation', 'coding'],
      envKey: 'OPENCODE_API_KEY',
      harness: 'opencode',
      providerModel: 'opencode-go/deepseek-v4-pro',
      experimental: true,
    },
    /** Added 2026-10-14 (#2904): DeepSeek V4.1 Flash on the Pi harness via OpenRouter, an approved zero-retention intermediary (ADR-0163). The OPENROUTER_API_KEY must have zero data retention (ZDR) enforced in OpenRouter's privacy settings; without ZDR this model must not be used. OpenRouter id `deepseek/deepseek-v4.1-flash` and prices $0.01584/$0.891 per 1M per https://openrouter.ai/api/v1/models, checked 2026-10-14 (ids came from the OpenRouter API only; `pi` was not installed to confirm with `pi --list-models`). Pin-only: in no tier. opt in with FACTORY_EXPERIMENTAL=1. */
    'pi-openrouter-deepseek-v4-flash': {
      provider: 'custom',
      tier: ['worker'],
      costPerMtokInput: 0.01584,
      costPerMtokOutput: 0.891,
      contextWindow: 1000000,
      capabilities: ['implementation', 'coding'],
      envKey: 'OPENROUTER_API_KEY',
      harness: 'pi',
      providerModel: 'openrouter/deepseek/deepseek-v4.1-flash',
      experimental: true,
    },
    /** Added 2026-10-14 (#2904): DeepSeek V4 Pro on the Pi harness via OpenRouter, an approved zero-retention intermediary (ADR-0163). The OPENROUTER_API_KEY must have zero data retention (ZDR) enforced in OpenRouter's privacy settings; without ZDR this model must not be used. OpenRouter id `deepseek/deepseek-v4-pro` and prices $0.95526/$1.91052 per 1M per https://openrouter.ai/api/v1/models, checked 2026-10-14 (ids came from the OpenRouter API only; `pi` was not installed to confirm with `pi --list-models`). Pin-only: in no tier. opt in with FACTORY_EXPERIMENTAL=1. */
    'pi-openrouter-deepseek-v4-pro': {
      provider: 'custom',
      tier: ['worker'],
      costPerMtokInput: 0.95526,
      costPerMtokOutput: 1.91052,
      contextWindow: 1000000,
      capabilities: ['implementation', 'coding'],
      envKey: 'OPENROUTER_API_KEY',
      harness: 'pi',
      providerModel: 'openrouter/deepseek/deepseek-v4-pro',
      experimental: true,
    },
    /** Added 2026-10-15 (#2908): DeepSeek V4.1 Flash on the claude-cli harness via OpenRouter's Anthropic-compatible endpoint (#2906), an approved zero-retention intermediary (ADR-0163). Secondary route: Pi (`pi-openrouter-deepseek-v4-flash`) is the main DeepSeek route. Verified 2026-10-15: tools PASS and thinking PASS (`deepseek/deepseek-v4.1-flash` lists tools, tool_choice, reasoning per https://openrouter.ai/api/v1/models; OpenRouter's Claude Code guide says the Anthropic skin passes through tool use and thinking blocks); ZDR PASS (enforceable per key through OpenRouter guardrails per https://openrouter.ai/docs/features/zdr) — the OPENROUTER_API_KEY must have ZDR enforced, without it this model must not be used; live `claude -p` call: not run (no OPENROUTER_API_KEY on the build machine). Prices $0.02376/$0.72 per 1M per https://openrouter.ai/api/v1/models, checked 2026-10-15; priced from the registry, not Claude Code's total_cost_usd (#2907). Pin-only: in no tier. opt in with FACTORY_EXPERIMENTAL=1. */
    'claude-openrouter-deepseek-v4-flash': {
      provider: 'custom',
      tier: ['worker'],
      costPerMtokInput: 0.02376,
      costPerMtokOutput: 0.72,
      contextWindow: 1000000,
      capabilities: ['implementation', 'coding'],
      envKey: 'OPENROUTER_API_KEY',
      harness: 'claude-cli',
      claudeFlag: 'deepseek/deepseek-v4.1-flash',
      endpoint: 'https://openrouter.ai/api',
      experimental: true,
    },
  },
  tiers: {
    boss: [
      'claude-opus-5',
      'qwen2.5-coder:14b',
      'gemma4:12b',
      'claude-fable-5',
      'claude-opus-4-8',
      'claude-sonnet-5',
      'glm-5.2',
      'gpt-5.6-terra-high',
    ],
    worker: [
      'codex-ollama-qwen3.5:9b',
      'qwen2.5-coder:14b',
      'qwen3.5:9b',
      'qwen3:8b',
      'gpt-5.6-terra-medium',
      'gpt-5.6-sol',
      'gpt-5.1-codex',
      'claude-sonnet-5',
      'glm-5.2',
      'qwen-3.5-coder',
      'opencode-sonnet',
    ],
    checker: [
      'qwen3.5:9b',
      'gemma4:12b',
      'qwen2.5-coder:14b',
      'qwen3:8b',
      'claude-sonnet-5',
      'gpt-5.6-luna-high',
      'glm-5.2',
    ],
    triage: ['qwen2.5-coder:14b', 'claude-sonnet-5', 'glm-5.2', 'gpt-5.6-luna-high'],
  },
  providerOrder: {
    boss: ['claude-opus-5', 'gpt-5.6-terra-high', 'opencode-deepseek-v4-flash'],
    worker: ['gpt-5.6-terra-medium', 'claude-sonnet-5', 'opencode-deepseek-v4-flash'],
    checker: ['claude-sonnet-5', 'gpt-5.6-luna-high', 'opencode-deepseek-v4-flash'],
    triage: ['claude-sonnet-5', 'gpt-5.6-luna-high', 'opencode-deepseek-v4-flash'],
  },
  failover: {
    triggers: ['rate_limit', 'unavailable', 'auth'],
    maxRetries: 2,
    cooldownMs: 5000,
  },
  routingRules: {
    codex_available: {
      if: 'command -v codex && FACTORY_CODEX != 0',
      worker_preferred: ['gpt-5.6-terra-medium', 'gpt-5.6-sol', 'gpt-5.1-codex'],
      boss_preferred: ['gpt-5.6-terra-high'],
      note: 'Codex flat-rate is cheapest for implementation when available. Phase-effort policy (#529): PLAN defaults to gpt-5.6-terra-high, BUILD defaults to gpt-5.6-terra-medium, both pinned explicitly via -m; gpt-5.6-sol and gpt-5.1-codex remain as failovers (pinned via -m, #415).',
    },
    ollama_available: {
      if: 'command -v ollama',
      worker_preferred_add: ['codex-ollama-qwen3.5:9b', 'qwen2.5-coder:14b', 'qwen3.5:9b', 'qwen3:8b'],
      note: 'Local Ollama models are free but slower; good for bulk work',
    },
    byok_active: {
      if: 'FACTORY_BYOK=1',
      skip_models_without_env: true,
      note: 'In BYOK mode, only use models whose env keys are present',
    },
  },
};

export interface RetiredModelDefaults {
  /** ADR that removed the model, e.g. 'ADR-0163'. */
  adr: string;
  /** Packaged model id to use instead. */
  replacement: string;
}

/** Packaged model ids that were removed, so unknown-model errors can say why and what to use instead. */
export const retiredModels: Readonly<Record<string, RetiredModelDefaults>> = {
  'deepseek-v3': { adr: 'ADR-0163', replacement: 'opencode-deepseek-v4-flash' },
};

/** Size caps for auto-filed bug evidence (#1842). Raw logs stay local; issues get a capped excerpt plus a host:path pointer. */
export interface EvidenceCapsDefaults {
  /** Max characters of the evidence excerpt placed in a filed bug body. */
  maxExcerptChars: number;
  /** Max characters of the whole filed bug body. */
  maxBodyChars: number;
}

export const defaultEvidenceCaps: EvidenceCapsDefaults = {
  maxExcerptChars: 2000,
  maxBodyChars: 8000,
};

/** Lane circuit breaker threshold (#1915): default for `budget.laneBreakerThreshold`. 0 turns the breaker off. */
export const defaultLaneBreakerThreshold = 2;

/** Global factory configuration: paths, timeouts, merge/worktree/budget/intake defaults. */
export const defaultFactoryConfig: FactoryDefaults = {
  version: 1,
  pr: { footer: 'This PR was made by Software Factory' },
  paths: {
    constitutions: 'constitutions/',
    checkers: 'lib/checkers/',
    plans: '.factory/plans/',
    logs: '.factory/logs/',
    events: '.factory/events.ndjson',
    constitution: '.factory/constitution.md',
  },
  timeouts: {
    plan_seconds: 1800,
    build_seconds: 7200,
    check_seconds: 1800,
    merge_poll_seconds: 120,
    approval_seconds: 1800,
    tests_seconds: 300,
    compile_seconds: 120,
  },
  merge: {
    auto: false,
    comment:
      'Set FACTORY_MERGE=1 to enable autonomous squash-merge; set FACTORY_MERGE_ADMIN=1 to bypass unmet merge requirements with GitHub admin privileges',
  },
  worktree: {
    parent: '~/.factory/worktrees',
    comment:
      'Where lane worktrees are created. "~/..." or an absolute path is a shared root, namespaced as <parent>/<owner>/<repo>/. ' +
      'A repo-relative path is used as-is: "../" gives the old sibling layout; ".factory/worktrees" keeps them inside the repo ' +
      "(auto-added to .git/info/exclude) but the repo's own tools (jest, eslint, tsc, globbing scripts) may crawl into those nested checkouts.",
    gcTtlDays: 7,
    autoGcOnRun: true,
  },
  byok: {
    enabled: false,
    comment: 'When true, only use models whose API keys are present in env',
  },
  notifications: {
    on_ship: true,
    on_fail: true,
    on_escalate: true,
    on_park: true,
    on_merge: true,
  },
  cost_tracking: {
    enabled: true,
    log_file: '.factory/costs.jsonl',
    comment: 'Per-task token usage and cost logged for analysis',
  },
  kpis: {
    defectWindowDays: 14,
    comment:
      'Post-merge defect window (#612): after a factory PR merges, follow-up signals (revert commits, new issues back-referencing the PR/issue/merge commit, non-bot post-merge comments raising concerns) are watched for this many days. A run is only scored once its window has closed. Override with FACTORY_DEFECT_WINDOW_DAYS.',
  },
  ci: {
    skip: false,
    comment: 'Set FACTORY_SKIP_CI=1 to skip waiting for GitHub Actions CI before merging',
  },
  sweep: {
    loopIntervalSeconds: 300,
    staleThresholdMultiplier: 2,
    comment:
      'Optional: set sweep.heartbeatFile (or export HEARTBEAT_FILE) to the path an auto-merge-sweep loop writes an ISO8601 timestamp to once per pass (see scripts/auto-merge-sweep.sh, docs/runbooks/sweep-heartbeat.md). factory doctor/status fail when it is older than loopIntervalSeconds * staleThresholdMultiplier seconds. Unset means no sweep is configured for this repo — no check runs.',
  },
  plan_approval: {
    enabled: false,
    comment:
      'OPTIONAL pre-code gate: when true (or --approve-plan / FACTORY_APPROVE_PLAN=1), PLAN pauses after freezing the spec and waits for operator approval before BUILD. Default off keeps unattended auto-plan. Independent of the SHIP/auto-merge gate.',
  },
  /**
   * Opt-in: when true, PLAN stops before BUILD if a behaviorDelta row with verdict worse/unknown is not listed in
   * openQuestions. Default false = log design_regression_unresolved only, like the other design checks.
   * FACTORY_DESIGN_BLOCK_REGRESSIONS=1/0 overrides.
   */
  design: { blockUnresolvedRegressions: false },
  /**
   * PLAN readiness enrichment (#2385). true writes the enriched sections back to the GitHub issue under a
   * factory:enriched block below the original text; false keeps enrichment in memory only.
   * FACTORY_READINESS_UPDATE_BODY=1/0 overrides.
   */
  readiness: { updateIssueBody: true },
  /**
   * BUILD policy (#1867). false keeps BUILD commit-only on every route (SHIP pushes and
   * opens the PR after CHECK); true lets the claude worker push and open a PR itself.
   */
  build: { publishFromBuild: false, contextCeiling: { 'codex-cli': 120000 } },
  /** Size gates on: an oversized issue files child issues or parks (ADR-0043). Slice cap 10 (ADR-0156). */
  sizeGate: { mode: 'file', maxSlices: 10, tokenBudget: 150000, maxFiles: 12 },
  sandbox: {
    enabled: true,
    runtime: 'auto',
    codexFullAccessTasks: [],
    writablePaths: [],
    network: { allow: ['api.anthropic.com', 'github.com'], blockTelemetry: false, mode: 'report' },
    resources: { cpuMs: 300000, memMb: 4096 },
    docker: { rolloutPercent: 0 },
    comment:
      'Containment for agentic build runs. Disable per-run with --no-sandbox or FACTORY_SANDBOX=0. Empty network.allow denies all egress; non-empty leaves egress open in report mode. Set sandbox.runtime (auto|sandbox-exec|firejail|docker-sandbox|none) or FACTORY_SANDBOX_RUNTIME to pick a runtime; auto probes the host. docker-sandbox is reserved for the microVM runtime and does not contain anything yet (#653). sandbox.docker.rolloutPercent (0-100) deterministically promotes that percentage of unpinned lanes into the docker-sandbox cohort for A/B evidence (#655). sandbox.network.blockTelemetry (default false) makes the egress proxy refuse known telemetry hosts (e.g. *.datadoghq.com) with 403, even if allowlisted; it only takes effect where the egress proxy runs (sandbox-exec with a non-empty allowlist) (#2667). sandbox.network.mode (report|enforce, default report; FACTORY_SANDBOX_NETWORK overrides) — enforce on sandbox-exec denies direct outbound connections and makes the egress proxy refuse hosts not on network.allow with 403 (#2215). sandbox.writablePaths (default []) adds directories BUILD/CHECK may write, e.g. ["~/.nuget"]; entries must be absolute or start with ~/, and may not be /, ~, the home dir, or a path equal to or containing the repo checkout (#3454).',
  },
  discovery: {
    enabled: true,
    schedule: 'weekly',
    maxCandidates: 5,
    comment:
      'Scheduled read-only scan that proposes a ranked, capped list of candidate ideas from product signals. No GitHub writes.',
  },
  filing: {
    enabled: true,
    excludeReasons: ['rate_limit', 'usage_cap', 'timeout', 'verify_failed'],
    repeatThreshold: 3,
    maxPerRun: 5,
    maxPerDay: 20,
    selfFixLabel: 'no-auto-merge',
    bugLabels: ['bug'],
    sensitivePaths: ['packages/core/', 'packages/config/', 'packages/cli/', 'scripts/', '.github/'],
    comment:
      'Guardrails for auto-filing self-defects. excludeReasons are never filed unless the same fingerprint parks >= repeatThreshold times. maxPerRun/maxPerDay cap new bugs. Bugs whose origin is factory-internal get selfFixLabel so the merge path refuses auto-merge (human approval required).',
  },
  ingest: {
    enabled: false,
    label: 'ready',
    lane: 'auto',
    maxPerCycle: 20,
    comment:
      'Always-on auto-ingest. When enabled, `factory supervise` polls each cycle for open issues carrying `label` and appends new ones (deduped against the queue and open factory/* PRs, legacy ship-it branches included) to the queue under `lane`. Enable per-run with FACTORY_AUTO_INGEST=1; disable with =0.',
  },
  intake: { enforce: 'warn' },
  environment: {
    ports: {
      enabled: true,
      range: [3100, 3999],
      comment:
        'Per-lane app-port leases (.factory/ports.json). Each lane gets a unique port injected as PORT/FACTORY_APP_PORT/FACTORY_BASE_URL into BUILD/CHECK agent runs. Disable per-run with FACTORY_ENV_PORTS=0.',
    },
    proxy: {
      enabled: false,
      port: 80,
      domain: 'factory.localhost',
      comment:
        'Opt-in loopback reverse proxy giving each lane a stable URL http://<lane>.<domain>[:port]. Routes resolve per-request from .factory/ports.json so they always track the lease lifecycle. Binds 127.0.0.1 only. *.localhost resolves to loopback in Chrome/Firefox and per RFC 6761; Safari/curl may need dnsmasq with a .test domain — documented, not solved, in v1. Started in-process by `factory run`/`supervise`, or manually via `factory proxy`. If the port cannot be bound (e.g. :80 without privileges on Linux) lanes degrade to port-based URLs with one informational log line. Override per-run with FACTORY_PROXY=1/0.',
    },
  },
  host: {
    maxBuilds: 2,
    maxAgentJobs: 1,
    loadGuard: { enabled: true, retrySeconds: 60 },
    comment:
      'Host-wide cap on lanes in BUILD or CHECK at once, shared by every runner on this machine through slot files in ~/.factory/host/build-slots/. A lane waits for a free slot before each BUILD/CHECK phase. maxAgentJobs caps ad-hoc rescue/steward jobs started with `factory agent-job`, through lease files in ~/.factory/host/agent-jobs/. loadGuard holds new issue claims while the host 5-minute load average is above maxLoad (default 3x CPU count), retrying every retrySeconds; enabled: false or FACTORY_LOAD_GUARD=0 turns it off.',
  },
  auto_failover: {
    enabled: true,
    cooldown_minutes: 30,
    fallback_model: 'claude-sonnet-5',
    comment:
      'Supervisor circuit breaker for cross-harness build failover. On a quota trip (usage_cap/rate_limit) the Codex provider is skipped for cooldown_minutes: the lane that trips it falls over to fallback_model (when available); every later lane during the cooldown is routed straight to claude via the existing codexDisabled path (default tier order, not necessarily fallback_model). Configure enabled, cooldown_minutes and fallback_model in .factory/config.json; environment variables do not override this policy.',
  },
  queue: {
    claim_settle_ms: 3000,
    comment:
      'GitHub-labels queue settings. claim_settle_ms is how long a lane waits after writing its claim before it confirms the claim, so a lane on another host racing for the same issue is seen (#3145). Non-negative integer milliseconds; 0 turns the wait off.',
  },
};
