# ADR-0041: Anti-slop lint rules are vendored, and only the zero-violation subset is enabled

- Status: Accepted
- Date: 2026-08-20

## Context

Written standards in CLAUDE.md and AGENTS.md do not stop agents from producing
low-evidence TypeScript; a linter does, deterministically, and anti-slop's diagnostics are
phrased as fix instructions the CHECK-phase rework loop in
`packages/core/src/phases/check.ts` can act on directly.

Two forces shaped this. First, upstream (https://github.com/dmmulroy/anti-slop, MIT) is
`"private": true`, unpublished, and its README states the project is designed to be
vendored and then edited to match the consuming team's standards — so there is no npm
dependency to take even if we wanted one. Second, of the fifteen generic rules, only six
report zero violations against this repo today. Enabling all fifteen at once would mean
either a large, risky, mixed diff touching production source across many packages, or
per-rule suppressions that hide real findings.

A vendored lint plugin also sits outside every convention this repo has for TypeScript.
It is not a workspace package, so `tsc -b` never sees it; it must not lint itself; its
upstream formatting mixes tabs and spaces so `prettier --check .` would reject it; knip
would call its files dead and its only dependency unused; and it ships its own `.test.ts`
files that must not join the vitest run or the coverage denominator.

Finally, oxlint's JS plugin API is explicitly alpha and "not subject to semver", and
`@oxlint/plugins` tracks `oxlint` release-for-release. A silent version drift between the
two would change rule-visitor behaviour without any diff to point at.

## Decision

We vendor anti-slop's `src/` verbatim into `tools/oxlint/anti-slop/`, pinned to a recorded
upstream commit, and keep it a byte-faithful mirror so re-syncing upstream is a readable
diff rather than an archaeology exercise. `tools/oxlint/anti-slop/VENDORED.md` records the
upstream URL, the exact commit, and the re-sync procedure, and the upstream MIT `LICENSE`
travels with the copy.

`oxlint.config.ts` registers only the generic entry point through `jsPlugins` under the
alias `anti-slop`. The Effect entry point stays unregistered because no package here
depends on `effect`.

We enable exactly the rules that already measure zero violations, at `error`, and we add
them one landing at a time. This first landing enables six: `no-object-parameters`,
`no-reflect-apply`, `no-reflect-get`, `no-shape-in-symbol-names`,
`no-unknown-type-aliases`, `no-widen-then-assert`. The remaining nine are enabled by
later, separately-reviewable changes that carry their own fixes. A rule is never enabled
together with a suppression for the code it fires on.

The vendored tree is excluded from every other repo gate at its own boundary: oxlint's
`ignorePatterns`, `.prettierignore`, and knip's `ignore`. Vitest needs no change — its
include glob is `packages/*/src/**`, which the vendored tree is outside of by construction,
and that is the reason the plugin lives under `tools/` rather than inside a package.

`@oxlint/plugins` is pinned to an exact version equal to the installed `oxlint`, and
`scripts/check-oxlint-plugin-version.sh` fails the build on drift. It runs from
`scripts/verify.sh` and from the `ci` workflow.

## Consequences

Positive: the six properties become a deterministic gate at zero production-code cost, and
the failure message an agent sees is a fix instruction rather than a style complaint.
Upgrades are auditable — the pinned commit plus a byte-faithful mirror make "what changed
upstream" a diff. The version guard turns an invisible alpha-API drift into a named,
early build failure.

Negative: we now carry ~30 vendored files nobody here wrote, held outside lint, format,
knip, typecheck, and test coverage — a deliberate blind spot, justified only because
upstream owns their correctness and we pin the commit. Upstream fixes do not arrive
automatically; someone must re-sync deliberately. Vendoring `src/` whole means unenabled
rules, including the Effect group, sit inert in the tree, which reads as dead code until
you know it is a mirror — VENDORED.md exists to say so. And the `oxlint` /
`@oxlint/plugins` pin means bumping the linter is now a two-package change that the guard
will refuse to let anyone do halfway.

## References

- [anti-slop (upstream, MIT)](https://github.com/dmmulroy/anti-slop)
- [Oxlint JS plugins (alpha, not subject to semver)](https://oxc.rs/docs/guide/usage/linter/js-plugins.html)
- [Issue #795 — Vendor the anti-slop oxlint plugin and enable the six zero-violation rules](https://github.com/on-par/software-factory/issues/795)
