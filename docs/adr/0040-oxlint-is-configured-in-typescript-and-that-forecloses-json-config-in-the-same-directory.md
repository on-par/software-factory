# ADR-0040: Oxlint is configured in TypeScript, and that forecloses JSON config in the same directory

- Status: Accepted
- Date: 2026-08-20

## Context

The repo linted through `.oxlintrc.json` since the TS 7 / Oxlint migration
(`docs/research/ts7-oxlint-migration-2026-07-26.md`). The planned anti-slop plugin needs
Oxlint's `jsPlugins` key, which is only honoured in the JavaScript/TypeScript config
format. Oxlint enforces exactly one config format per directory: with both
`.oxlintrc.json` and `oxlint.config.ts` present it refuses to run at all
("Only one of `.oxlintrc.json` and `oxlint.config.ts` is allowed per directory"), so
there is no transition period, no side-by-side comparison run, and no partial rollout.
Working against that, `oxlint --help` still labels JavaScript/TypeScript config files
experimental and notes they require running via Node.js. Both constraints were verified
against the pinned `oxlint@1.78.0` in this checkout: `defineConfig` is exported from the
package root, and `node_modules/oxlint/bin/oxlint` is a `#!/usr/bin/env node` shim, so
`npm run lint` already satisfies the Node-only loader without any flag change.

## Decision

Configure Oxlint from `oxlint.config.ts` at the repository root, exporting
`defineConfig({...})`, and delete `.oxlintrc.json`. The two files must never coexist —
re-introducing `.oxlintrc.json` in the repo root breaks `npm run lint` outright rather
than being merged or ignored, so any future lint-config change is an edit to
`oxlint.config.ts`. The `$schema` key is deliberately not carried across: in the
TypeScript format the equivalent guarantee comes from `defineConfig`'s `OxlintConfig`
type parameter. The format flip ships alone, with zero rule changes, so that any lint
regression traced to it is unambiguous.

## Consequences

Positive: `jsPlugins` and the rest of the TS-only config surface become available;
the config is type-checked at author time by `OxlintConfig` instead of by a JSON schema
an editor may or may not load; comments and derived values are now expressible.
Negative: the repo depends on a config format Oxlint itself still labels experimental,
and on the config being loaded through Node — a non-Node Oxlint runtime could no longer
read it. The lint config is now a module that executes at lint time rather than inert
data, so it must stay lint-clean and Prettier-clean like any other source file. Reversal
means writing the JSON back and deleting the TS file in the same commit; a half-reverted
state does not lint at all.

## References

- [Issue #794 — Migrate .oxlintrc.json to oxlint.config.ts (no behaviour change)](https://github.com/on-par/software-factory/issues/794)
- [Oxlint type-aware linting](https://oxc.rs/docs/guide/usage/linter/type-aware.html)
