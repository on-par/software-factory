// packages/core/src/config/merge-policy.ts — auto-merge, admin-merge and PR-classifier precedence, moved out of
// config/index.ts unchanged so index.ts stays under its max-lines ceiling (#3905).
import type { FactoryConfig } from './index.js';
import { resolvePrecedence, type ConfigSource } from './precedence.js';

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
  /** From `--admin` (#3905): admin-merge past unmet branch protection. Never bypasses red CI. */
  admin?: boolean;
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
      { source: 'flag', read: () => overrides.admin },
      { source: 'repo', read: () => config.run?.merge?.admin },
      { source: 'env', read: () => (env.FACTORY_MERGE_ADMIN === '1' ? true : undefined) },
    ],
    false,
  );

  return { auto: auto.value, admin: admin.value, sources: { auto: auto.source, admin: admin.source } };
}
