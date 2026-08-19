# ADR-0033: Shipped factory defaults are typed TypeScript, never packaged JSON

- Status: Accepted
- Date: 2026-08-19

## Context

The shipped defaults — the model registry with its tiers and failover chains, the
task-type routes, and the run/budget/intake settings — were three JSON files in
packages/config/src/. packages/config/tsconfig.build.json included src/**/*.json, so
`tsc -b` emitted a second copy of each into packages/config/dist/, while core's loaders
read the src/ copies via resolveConfigPath()'s dist->../src fallback and the config
package additionally re-exported the same files through `import ... with { type: 'json' }`.
Three views of one dataset, two of them on disk, is a drift class rather than a bug: a
stale dist copy or a hand-edited .bak next to it can disagree with src about what the
factory's defaults are, and nothing detects it. JSON also cannot carry documentation, so
the intent behind each setting was smuggled in as data — 14 `"comment"` fields in
factory.json and a `"note"` on nearly every model, the latter silently stripped by the
zod schema at load. Meanwhile the config package must stay zero-dependency and must not
import core (the dependency direction is config <- core), so it cannot reuse core's
zod-inferred types.

## Decision

The shipped defaults live in packages/config/src/defaults.ts as typed TypeScript values
— `defaultModelsConfig`, `defaultRoutesConfig`, `defaultFactoryConfig` — and nowhere
else. packages/config ships no JSON other than its own package.json/tsconfig files, and
scripts/check-config-json.sh (run by scripts/verify.sh and by the `ci` workflow job,
both after the build) fails the build when any *.json or *.bak appears under
packages/config/src or packages/config/dist. defaults.ts declares its own structural
interfaces rather than importing core's zod-inferred types, keeping the package
zero-dependency and the dependency direction intact; core's schemas remain the single
runtime validator and still `.parse()` the defaults on every load, so an invalid default
fails exactly where an invalid JSON file used to. The loaders keep their optional `path`
parameter: an explicit path still reads and validates an external JSON config, which is
how a consuming repo or a test supplies its own. Documentation for a default is a JSDoc
comment on the value, never a `comment` or `note` field — except the four `comment`
strings FactoryConfigSchema still declares required, which the v2-schema work removes.

## Consequences

Positive: one authoritative copy of the defaults, checked by the compiler; a typo in a
tier list or a model id is a build error rather than a runtime surprise; documentation
sits next to the value it explains and cannot be mistaken for data; the dist-vs-src
disagreement is structurally impossible and guarded in CI.
Negative: editing the defaults now requires a rebuild rather than editing a file in a
published package, so a downstream user can no longer patch models.json in node_modules
— they use .factory/config.json (per-repo overrides) or an explicit loader path instead.
The default shapes are described twice, as interfaces in config and as zod schemas in
core, and the two must be kept in step by hand; this is the same deliberate duplication
ADR-0010 accepted for the size gate, and core's parse of the defaults is what catches
any divergence.

## References

- [Issue #716 — singular-config: ship defaults as typed TS](https://github.com/on-par/software-factory/issues/716)
- [ADR-0010 (deliberate cross-package duplication precedent)](https://github.com/on-par/software-factory/blob/main/docs/adr/0010-the-readiness-size-gate-re-implements-the-invest-small-rule-inside-core.md)
