import type { FactoryConfig, ModelsConfig, RoutesConfig } from '../config/index.js';
import type { EffectiveConfig } from '../config/repo.js';

/** Per-run budget caps. A single run's spend limits, already resolved. */
export interface RunBudget {
  /** Per-issue spend cap in USD; undefined = uncapped (the shipped default). */
  perIssueCapUsd?: number;
}

/** Everything one run needs decided, as a plain resolved value — NOT a config
 *  loader. File/env precedence resolution stays in the CLI adapter (see #673 /
 *  ADR); callers construct a RunPolicy from already-resolved config. */
export interface RunPolicy {
  /** Model registry + tiers this run routes against (after repo overrides applied). */
  models: ModelsConfig;
  /** Task-type → tier routing table. */
  routes: RoutesConfig;
  /** Sandbox containment inputs — the FactoryConfig `sandbox` section that
   *  resolveSandboxPolicy consumes. Not the resolved SandboxPolicy (that needs
   *  per-run worktree/repoRoot paths, resolved at call time). */
  sandbox: FactoryConfig['sandbox'];
  /** Per-run budget caps. */
  budget: RunBudget;
  /** Resolved FACTORY_* env-override values one run needs (#668). */
  effective: EffectiveConfig;
}
