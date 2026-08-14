# ADR-0028: Factory config v2 is one sparse, strict, self-documenting overlay schema

- Status: Accepted
- Date: 2026-08-14

## Context

Factory configuration was split across three packaged v1 files
(factory.json, models.json, routes.json) with three separate zod schemas
plus a differently-shaped per-repo `.factory/config.json`. There was no
single answer to "what can I configure?", documentation lived in
`"comment"` pseudo-fields inside the JSON data, and the packaged
`dist/` copies had already drifted from `src/`. Follow-up issues
(typed-TS defaults, precedence ladder, v1 adapter, `factory migrate`)
all need one schema to build on.

## Decision

`packages/core/src/config/v2.ts` owns a single versioned v2 config
schema, `FactoryConfigV2Schema`, covering the entire configuration
surface in one document: `models` (registry/tiers/pins/providers/
failover), `routes`, `run` (timeouts, merge, worktree, ci, planApproval,
sandbox, environment, failover, kpis), `budget`, `intake` (ingest,
discovery, filing), `constitution`, and `notifications`. The schema is
strict at every level, uses camelCase field names, and gives every
section a default, so `.factory/config.json` is a sparse overlay where
`{"version": 2}` is a complete valid config. Documentation lives in the
schema as `.describe()` metadata surfaced through a generated JSON
Schema (`factoryConfigV2JsonSchema()`, draft 2020-12 with `$schema`);
v2 files carry no `comment`/`note` pseudo-doc fields, and a top-level
`"$schema"` key is explicitly allowed for editor tooling. The v1
schemas and loaders are untouched; `loadRepoConfig` validates a
version-2 file against the v2 schema and returns `null` until the
in-memory v2→v1 adapter lands, so v1 consumers treat a v2 repo as
"no overrides" rather than an error.

## Consequences

Positive: one discoverable, machine-documented answer to "what can I
configure"; typo-proof overlays (strict everywhere); every future config
issue extends one schema instead of four; JSON-Schema-aware editors get
completion and inline docs for free. Negative: until the adapter issue
lands, settings in a v2 file are validated but not yet consumed by the
engine (v1 files remain the operative override path); the v2 default
values are temporarily duplicated with the packaged v1 JSONs until the
typed-TS-defaults issue replaces those files; camelCase renames mean v1
and v2 field names differ, which `factory migrate` must map.

## References

- [Issue #715](https://github.com/on-par/software-factory/issues/715)
