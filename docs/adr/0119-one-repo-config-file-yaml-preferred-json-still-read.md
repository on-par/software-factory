# ADR-0119: One repo config file, YAML preferred, JSON still read

- Status: Accepted
- Date: 2026-10-01

## Context

ADR-0042 established that one repo-owned file, `.factory/config.json`, carries both the model-routing namespace (`loadRepoConfig`) and the runtime-policy namespace (`loadFactoryConfigForRepo`). Plain JSON cannot hold comments, so operators cannot record why a model is pinned or why a path always needs a human. Four loaders each parsed the file with `JSON.parse` directly, so any format change had to be made four times. Every existing checkout has a `config.json`, which must keep working unchanged, and `packages/config` must remain zero-dependency.

## Decision

A repo still has exactly one config file, but it may be `.factory/config.yaml` (preferred), `.factory/config.yml`, or `.factory/config.json`. All repo-config reads go through one core reader, `readRepoConfigFile` in `packages/core/src/config/repo-config-file.ts`, which parses YAML with the `yaml` package (a dependency of `@on-par/factory-core`, never of `@on-par/factory-config`) and JSON with `JSON.parse`, producing the same plain object either way so every Zod schema is unchanged. `getFactoryPaths().config` resolves to whichever of the three exists, in that preference order, and defaults to `config.yaml` when none exists. If more than one exists, loading fails with an error naming each file; the factory never merges or picks silently. The daemon's `FACTORY_RUN_CONFIG_JSON` snapshot remains JSON. This amends ADR-0042: the "one file, two disjoint namespaces, two loaders" rule stands, but the one file is no longer necessarily JSON. New code must read repo config through this reader and must not call `JSON.parse` on `getFactoryPaths().config` directly.

## Consequences

Operators can comment their config, and existing `config.json` repos keep working with identical behavior and error text. Core gains one runtime dependency (`yaml`). Having two config files at once is now a hard error rather than an ambiguity. Until the writers (the safe-policy writer, `factory migrate`) and the daemon's checkout-validation/run-worktree paths are updated, the policy writer drops comments when it rewrites a YAML file, and the daemon does not yet recognize a YAML-only repo. `factory init` still writes `config.json`.
