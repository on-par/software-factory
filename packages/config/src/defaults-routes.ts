// packages/config/src/defaults-routes.ts — the shipped task-type → tier routes.
// Split out of defaults.ts to stay under the max-lines ceiling; defaults.ts re-exports these.

export interface RouteDefaults {
  tier: string;
  description: string;
  requires?: string;
  /** Pinned model-registry key (a key of defaultModelsConfig.models) used instead of resolving the tier. An exact ID, never an alias. */
  model?: string;
  /** Explicit tool allow-list for the route's model call. An empty array means tool-less: no file, shell or network tools. */
  allowedTools?: string[];
  /** Output contract for the route's model call. 'json' means the model must return exactly one JSON object. */
  output?: 'json';
}

export interface RoutesDefaults {
  version: number;
  routes: Record<string, RouteDefaults>;
}

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
        'Claude implementation from frozen spec (design/UX tasks) - requires the claude-cli harness, which drives its own commits (commit-only; SHIP publishes after CHECK)',
      requires: 'claude',
    },
    build_opencode: {
      tier: 'worker',
      description:
        'OpenCode CLI implementation from frozen spec - requires the opencode harness (e.g. opencode-deepseek-v4-flash)',
      requires: 'opencode',
    },
    build_command: {
      tier: 'worker',
      description:
        'Declared agentic harness implementation from frozen spec - requires a harness declared under `harnesses` with agentic: true (commit-only; SHIP publishes after CHECK)',
      requires: 'command',
    },
    check_compile: { tier: 'checker', description: 'Build/compile verification' },
    check_tests: { tier: 'checker', description: 'Test suite execution and result verification' },
    check_lint: { tier: 'checker', description: 'Linting and type checking' },
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
    classify_pr: {
      tier: 'checker',
      description: 'PR classifier: escalate-only review class (A/B/C) from the diff (ADR-0121)',
    },
    steward: {
      tier: 'boss',
      description:
        'Stuck-run steward (ADR-0155): one tool-less call over the sanitized packet, returning one JSON verdict; model: a pin, else the first runnable boss-tier model',
      allowedTools: [],
      output: 'json',
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
