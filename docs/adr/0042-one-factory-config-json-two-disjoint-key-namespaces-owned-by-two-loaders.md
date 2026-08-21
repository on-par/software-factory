# ADR-0042: One `.factory/config.json`, two disjoint key namespaces owned by two loaders

- Status: Accepted
- Date: 2026-08-21

## Context

`.factory/config.json` is validated by two different zod schemas that know nothing about
each other. `RepoFactoryConfigSchema` (`packages/core/src/config/repo.ts`) is `.strict()`
and owns the model-routing namespace — `version`, `models`, `tiers`, `providers`, `usage`,
`efficiency`, `route` — and its strictness is load-bearing: it is how a typo in a model pin
is rejected loudly instead of being silently ignored. `FactoryConfigSchema`
(`packages/core/src/config/index.ts`) owns the runtime-policy namespace — `merge`,
`worktree`, `timeouts`, `ci`, `filing`, `ingest`, `kpis`, `environment` and the rest — and
requires seven of those sections outright, with no defaults.

The result was that neither namespace could see the other. Every runtime-policy read in
`packages/cli/src/cli/index.ts` called `loadFactoryConfig()` with no path, which returns the
packaged `defaultFactoryConfig`, so a repo's `merge.auto`, `worktree.autoGcOnRun`,
`ci.skip`, `kpis.defectWindowDays`, `ingest.*`, `plan_approval.enabled` and filing policy
were silently ignored (#819). Passing `paths.config` into `loadFactoryConfig` was not a
fix — every real `.factory/config.json` is a repo-namespace file and would fail
`FactoryConfigSchema`'s required sections — and writing `"merge"` into the file made the
strict `loadRepoConfig` throw. Splitting into two files was rejected: one repo-owned config
file is the documented, already-shipped surface, and moving it would break every existing
checkout.

## Decision

One file carries both namespaces, and the split is made explicit rather than implicit.
`packages/core/src/config/index.ts` exports `FACTORY_RUNTIME_CONFIG_KEYS`, the literal list
of top-level keys owned by `FactoryConfigSchema`, and that list is the single authority both
loaders consult.

`loadFactoryConfigForRepo(configPath)` reads only those keys out of the file, deep-merges
them over the shipped `defaultFactoryConfig`, and validates the merged object — so a partial
section such as `{"merge": {"auto": true}}` is a legal override and every unspecified field
is inherited from the defaults. It returns the shipped defaults unchanged when the file is
absent. `loadRepoConfig` deletes those same keys before its `.strict()` parse, so the
runtime namespace passes through untouched while typos in the model namespace still fail
loudly. `version` is deliberately excluded from the list: it belongs to the repo namespace,
and the FactoryConfig `version` always comes from the shipped defaults.

Every runtime-policy read in the CLI goes through `loadFactoryConfigForRepo(paths.config)`.
`loadFactoryConfig(path?)` keeps its exact current meaning — shipped defaults, or a fully
FactoryConfig-shaped file at an explicit path — and is not the loader any CLI command uses
for a repo file.

## Consequences

Positive: a repo's `.factory/config.json` finally controls the runtime policy it appears to
control, with no env var required; partial overrides are legal, so a one-line file works;
model-pin typo detection is preserved intact; and the namespace boundary is a named,
testable constant instead of an undocumented convention split across two modules.

Negative: adding a new top-level section to `FactoryConfigSchema` now has a second,
easy-to-forget obligation — it must also be added to `FACTORY_RUNTIME_CONFIG_KEYS`, or the
new section will be dropped by `loadFactoryConfigForRepo` and simultaneously rejected as an
unknown key by `loadRepoConfig`'s strict parse. A key name may never be claimed by both
namespaces. And unknown top-level keys that belong to neither namespace are still rejected
by `loadRepoConfig`, which is intentional but means the file has no free-form extension
space.

## References

- [Issue #819 — .factory/config.json merge.auto is never read](https://github.com/on-par/software-factory/issues/819)
- [ADR-0004 — A narrow public API for @on-par/factory-core](https://github.com/on-par/software-factory/blob/main/docs/adr/0004-narrow-public-core-api.md)
