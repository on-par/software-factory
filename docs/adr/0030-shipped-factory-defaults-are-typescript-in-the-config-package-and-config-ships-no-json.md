# ADR-0030: Shipped factory defaults are TypeScript in the config package, and config ships no JSON

- Status: Accepted
- Date: 2026-08-19

## Context

The shipped model registry, route table and run/budget/intake defaults lived as
three JSON files under `packages/config/src/`. `packages/config/tsconfig.json`
set `resolveJsonModule` and `tsconfig.build.json` included `src/**/*.json`, so
`tsc -b` emitted a second copy of each file into `packages/config/dist/`, while
`resolveConfigPath()` deliberately redirected `dist/` back to `../src/`. The
package therefore had two load paths that could disagree about which copy was
authoritative — the static `export { default as modelsConfig } from
'./models.json'` re-exports resolved to the dist copy after a build, the
`readFileSync` loaders in `packages/core/src/config/index.ts` resolved to src —
and hand-edited `.bak` files accumulated next to the dist copies. JSON also
cannot carry comments, so `factory.json` documented itself through 14 `"comment"`
string fields that the Zod schema had to model as real data. Any fix that keeps
JSON in the package keeps the second copy and keeps the drift class alive.

## Decision

The shipped defaults are TypeScript. `packages/config/src/defaults.ts` exports
`defaultModelsConfig`, `defaultRoutesConfig` and `defaultFactoryConfig` as plain
object literals, re-exported from the package root; `packages/config` ships no
JSON other than its own `package.json` and `tsconfig*.json`. The literals carry
no local type annotations — the Zod schemas in `packages/core/src/config/index.ts`
remain the single validation authority, so the shapes are never declared twice
and the config package stays zero-dependency. `loadModelsConfig`,
`loadRoutesConfig` and `loadFactoryConfig` validate those objects when called
with no path, and keep reading and validating a file when given one. The
`./models.json`, `./routes.json` and `./factory.json` subpath exports are
removed, `resolveJsonModule` and the `src/**/*.json` build include are dropped
so a future JSON import fails to compile, and a colocated test fails the CI
test run if any `*.json` appears under `packages/config/src` or
`packages/config/dist`.

## Consequences

Positive: exactly one copy of the shipped defaults exists at exactly one path;
the src-versus-dist ambiguity is structurally impossible rather than merely
discouraged; defaults can now carry real TSDoc; a typo in a tier list is a
compile-or-test failure rather than a runtime routing surprise.
Negative: the defaults are no longer readable or patchable by non-TypeScript
tooling, so anything outside this repo that parsed
`packages/config/src/models.json` must change; the config package now compiles
a large data module; and the `"comment"` fields inside `defaultFactoryConfig`
stay as data (the Zod schema still requires several of them) until the v2
schema issue retires them, so the file briefly carries both real comments and
pseudo-doc strings.

## References

- [Issue](https://github.com/on-par/software-factory/issues/716)
- [ADR-0001 — config is the source of truth for routing](https://github.com/on-par/software-factory/blob/main/docs/adr/0001-boss-worker-checker-pipeline.md)
