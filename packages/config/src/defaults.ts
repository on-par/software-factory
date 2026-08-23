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
  contextWindow: number;
  capabilities: string[];
  envKey: string | null;
  claudeFlag?: string;
  providerModel?: string;
  providerOptions?: Record<string, unknown>;
  codex?: boolean;
  codexFlag?: string;
  harness?: string;
  experimental?: boolean;
}

export interface ModelsDefaults {
  version: number;
  models: Record<string, ModelDefaults>;
  tiers: Record<string, string[]>;
  failover: { triggers: string[]; maxRetries: number; cooldownMs: number; escalateAfterTierExhausted: boolean };
  routingRules: Record<string, unknown>;
}

export interface RouteDefaults {
  tier: string;
  description: string;
  requires?: string;
}

export interface RoutesDefaults {
  version: number;
  routes: Record<string, RouteDefaults>;
}

export interface FactoryDefaults {
  version: number;
  paths: { constitutions: string; checkers: string; plans: string; logs: string; events: string };
  timeouts: {
    plan_seconds: number;
    build_seconds: number;
    check_seconds: number;
    merge_poll_seconds: number;
    approval_seconds: number;
  };
  merge: { auto: boolean; comment: string };
  worktree: { prefix: string; parent: string; comment: string; gcTtlDays: number; autoGcOnRun: boolean };
  byok: { enabled: boolean; comment: string };
  notifications: Record<string, boolean>;
  cost_tracking: { enabled: boolean; log_file: string; comment: string };
  // ci/plan_approval/kpis/sandbox/discovery/filing/ingest/environment ports+proxy/auto_failover.comment are
  // schema-optional (FactoryConfigSchema declares them z.string().optional()), but this package keeps them as
  // data anyway: dropping them would desync loadFactoryConfig()'s no-path output from what the deleted
  // factory.json produced, breaking the byte-identical behavior contract (#716).
  kpis: { defectWindowDays: number; comment?: string };
  ci: { skip: boolean; comment?: string };
  plan_approval: { enabled: boolean; comment?: string };
  sandbox: {
    enabled: boolean;
    network: { allow: string[] };
    resources: { cpuMs: number; memMb: number };
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
    comment?: string;
  };
  ingest: { enabled: boolean; label: string; lane: string; maxPerCycle: number; comment?: string };
  environment: {
    ports: { enabled: boolean; range: [number, number]; comment?: string };
    proxy: { enabled: boolean; port: number; domain: string; comment?: string };
  };
  auto_failover: { enabled: boolean; cooldown_minutes: number; fallback_model: string; comment?: string };
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
      tier: ['worker', 'checker'],
      costPerMtokInput: 1.25,
      costPerMtokOutput: 10.0,
      contextWindow: 272000,
      capabilities: ['implementation', 'verification', 'codex'],
      envKey: null,
      harness: 'codex-cli',
      codex: true,
      codexFlag: '-m gpt-5.6-luna -c model_reasoning_effort=high',
    },
    /** claude-CLI wiring is unproven — the Claude CLI only serves Anthropic models */
    'gpt-4.1-mini': {
      provider: 'openai',
      tier: 'checker',
      costPerMtokInput: 0.4,
      costPerMtokOutput: 1.6,
      contextWindow: 128000,
      capabilities: ['verification', 'lightweight_review'],
      envKey: 'OPENAI_API_KEY',
      harness: 'claude-cli',
      claudeFlag: 'gpt-4.1-mini',
      experimental: true,
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
    'deepseek-v3': {
      provider: 'deepseek',
      tier: 'worker',
      costPerMtokInput: 0.07,
      costPerMtokOutput: 0.28,
      contextWindow: 128000,
      capabilities: ['implementation', 'coding'],
      envKey: 'DEEPSEEK_API_KEY',
      harness: 'claude-cli',
      claudeFlag: 'deepseek/deepseek-chat',
      experimental: true,
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
    /** Added 2026-08-12 per Patrick's OpenCode Go subscription (OPENCODE_API_KEY env var). Served via OpenCode Go (https://opencode.ai/zen/go/v1) — distinct provider from OpenCode Zen (opencode/... prefix, pay-per-use, $0 balance when this was set up; do not confuse the two, same env var backs both). Confirmed working live: `opencode run --model opencode-go/deepseek-v4-flash "..."` returns real output. opt in with FACTORY_EXPERIMENTAL=1. */
    'opencode-deepseek-v4-flash': {
      provider: 'custom',
      tier: ['worker'],
      costPerMtokInput: 0.07,
      costPerMtokOutput: 0.14,
      contextWindow: 1000000,
      capabilities: ['implementation', 'coding'],
      envKey: 'OPENCODE_API_KEY',
      harness: 'opencode',
      providerModel: 'opencode-go/deepseek-v4-flash',
      experimental: true,
    },
    /** Added 2026-08-17: OpenCode Go's monthly usage cap ($60/mo) hit 100% and doesn't reset until 2026-09-13, blocking opencode-deepseek-v4-flash. This is OpenCode Zen's (not Go's) promo-period free tier for the same model, opencode/... prefix, no balance or subscription quota involved. Anoma.ly's privacy notice: during the free promo, request data may be used to improve the model (not the zero-retention terms Go/paid Zen get) — acceptable for skunkworks throwaway prototypes, reconsider before using on anything with real user/client data. Free tier may be pulled without notice; if `opencode/deepseek-v4-flash-free` starts erroring, check https://opencode.ai/docs/zen/ for current free-tier availability. Confirmed working live: `opencode run --model opencode/deepseek-v4-flash-free "..."` returns real output. opt in with FACTORY_EXPERIMENTAL=1. */
    'opencode-deepseek-v4-flash-free': {
      provider: 'custom',
      tier: ['worker'],
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000000,
      capabilities: ['implementation', 'coding'],
      envKey: 'OPENCODE_API_KEY',
      harness: 'opencode',
      providerModel: 'opencode/deepseek-v4-flash-free',
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
      'deepseek-v3',
      'qwen-3.5-coder',
      'opencode-sonnet',
      'opencode-deepseek-v4-flash-free',
    ],
    checker: [
      'qwen3.5:9b',
      'gemma4:12b',
      'qwen2.5-coder:14b',
      'qwen3:8b',
      'claude-sonnet-5',
      'gpt-4.1-mini',
      'glm-5.2',
    ],
    triage: ['qwen2.5-coder:14b', 'claude-sonnet-5', 'glm-5.2'],
  },
  failover: {
    triggers: ['rate_limit', 'usage_cap', 'timeout', 'error', 'empty_response'],
    maxRetries: 2,
    cooldownMs: 5000,
    escalateAfterTierExhausted: true,
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

/** Task-type → model-tier routing. The router resolves a tier to the first available model. */
export const defaultRoutesConfig: RoutesDefaults = {
  version: 1,
  routes: {
    plan: {
      tier: 'boss',
      description: 'Spec writing, architecture, route selection — needs judgment',
    },
    readiness_enrich: {
      tier: 'triage',
      description: 'Create a complete factory-task issue body before PLAN',
    },
    decompose: {
      tier: 'triage',
      description:
        'Decompose an oversized factory-task issue into an epic + INVEST-sized stories (proposed as a comment, not filed)',
    },
    build_codex: {
      tier: 'worker',
      description: 'Codex CLI implementation from frozen spec',
      requires: 'codex',
    },
    build_claude: {
      tier: 'worker',
      description:
        'Claude implementation from frozen spec (design/UX tasks) - requires the claude-cli harness, which drives its own commits',
      requires: 'claude',
    },
    build_opencode: {
      tier: 'worker',
      description:
        'OpenCode CLI implementation from frozen spec - requires the opencode harness (e.g. opencode-deepseek-v4-flash)',
      requires: 'opencode',
    },
    check_compile: {
      tier: 'checker',
      description: 'Build/compile verification',
    },
    check_tests: {
      tier: 'checker',
      description: 'Test suite execution and result verification',
    },
    check_lint: {
      tier: 'checker',
      description: 'Linting and type checking',
    },
    check_accessibility: {
      tier: 'checker',
      description: 'WCAG/accessibility checks in real browser',
    },
    check_links: {
      tier: 'checker',
      description: 'URL/link resolution and validation',
    },
    check_custom: {
      tier: 'checker',
      description: 'Product-specific custom checks (from constitution)',
    },
    check_design: {
      tier: 'checker',
      description: "Program-design smell critic over the lane's real diff",
    },
    eval_judge: {
      tier: 'checker',
      description: 'LLM judge scoring eval specs against a rubric',
    },
    review_pr: {
      tier: 'checker',
      description: 'Code review of the final diff before PR',
    },
    security_review: {
      tier: 'checker',
      description: 'Security review of the diff',
    },
    dispute_resolution: {
      tier: 'boss',
      description: 'Boss arbitrates when worker disputes checker failure',
    },
    triage: {
      tier: 'triage',
      description: 'Issue triage and queue building',
    },
  },
};

/** Global factory configuration: paths, timeouts, merge/worktree/budget/intake defaults. */
export const defaultFactoryConfig: FactoryDefaults = {
  version: 1,
  paths: {
    constitutions: 'constitutions/',
    checkers: 'lib/checkers/',
    plans: '.factory/plans/',
    logs: '.factory/logs/',
    events: '.factory/events.ndjson',
  },
  timeouts: {
    plan_seconds: 1800,
    build_seconds: 7200,
    check_seconds: 1800,
    merge_poll_seconds: 120,
    approval_seconds: 1800,
  },
  merge: {
    auto: false,
    comment:
      'Set FACTORY_MERGE=1 to enable autonomous squash-merge; set FACTORY_MERGE_ADMIN=1 to bypass unmet merge requirements with GitHub admin privileges',
  },
  worktree: {
    prefix: 'ship-it/',
    parent: '../',
    comment: 'Worktrees created as siblings of the repo',
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
  plan_approval: {
    enabled: false,
    comment:
      'OPTIONAL pre-code gate: when true (or --approve-plan / FACTORY_APPROVE_PLAN=1), PLAN pauses after freezing the spec and waits for operator approval before BUILD. Default off keeps unattended auto-plan. Independent of the SHIP/auto-merge gate.',
  },
  sandbox: {
    enabled: true,
    network: { allow: ['api.anthropic.com', 'github.com'] },
    resources: { cpuMs: 300000, memMb: 4096 },
    comment:
      'Containment for agentic build runs. Disable per-run with --no-sandbox or FACTORY_SANDBOX=0. Empty network.allow denies all egress; non-empty leaves egress open (per-host filtering is logged as degraded in v1).',
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
      'Always-on auto-ingest. When enabled, `factory supervise` polls each cycle for open issues carrying `label` and appends new ones (deduped against the queue and open ship-it/* PRs) to the queue under `lane`. Enable per-run with FACTORY_AUTO_INGEST=1; disable with =0.',
  },
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
  auto_failover: {
    enabled: true,
    cooldown_minutes: 30,
    fallback_model: 'claude-sonnet-5',
    comment:
      'Supervisor circuit breaker for cross-harness build failover. On a quota trip (usage_cap/rate_limit) the Codex provider is skipped for cooldown_minutes: the lane that trips it falls over to fallback_model (when available); every later lane during the cooldown is routed straight to claude via the existing codexDisabled path (default tier order, not necessarily fallback_model). Disable with FACTORY_AUTO_FAILOVER=0; override cooldown with FACTORY_FAILOVER_COOLDOWN_MINUTES, fallback with FACTORY_FAILOVER_MODEL.',
  },
};
