# @on-par/product

The product app — the **proposer** half of the product family. It turns a PM's
brain-dump into engineering-ready issues. It is **read-only**: it proposes, it
never writes the target codebase.

This package is private and is never published to npm.

## Status

This is the foundation slice (#469): a runnable `product --help` CLI skeleton
with no product behavior yet. Later stories in epic #463 fill in the
interviewer, intent doc, decomposer, persona panel, judge/rework loop,
readiness report, export, epic architecture design, and ADR reader.

## Commands

- `product --help` — usage and the list of available commands.
- `product adr home` — prints the absolute path of the shared monorepo ADR
  home.
- `product adr next "<title>"` — prints the filename for the next ADR in that
  home, numbered by `@on-par/adr-kit`.

## ADR home

The product app records its architecture decisions in the repo-root
[`docs/adr/`](../../docs/adr/README.md) — the single shared monorepo ADR home.
`@on-par/adr-kit`'s numbering is per-directory (it maxes over the numbers
already present in a directory), so a second ADR home under
`packages/product` would mint a second, colliding "ADR-0005" and make every
cross-reference ambiguous. One home means one numbering namespace.
