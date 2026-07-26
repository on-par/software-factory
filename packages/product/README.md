# @on-par/product

The product app — the **proposer** half of the product family. It turns a PM's
brain-dump into engineering-ready issues. It is **read-only**: it proposes, it
never writes the target codebase.

This package is private and is never published to npm.

## Status

The foundation slice (#469) shipped a runnable `product --help` CLI skeleton.
This story (#470) adds the Interviewer: given a PM's brain-dump, it asks
clarifying questions until intent is pinned. Later stories in epic #463 fill
in the intent doc, decomposer, persona panel, judge/rework loop, readiness
report, export, epic architecture design, and ADR reader.

## Commands

- `product --help` — usage and the list of available commands.
- `product adr home` — prints the absolute path of the shared monorepo ADR
  home.
- `product adr next "<title>"` — prints the filename for the next ADR in that
  home, numbered by `@on-par/adr-kit`.
- `product interview --text "<brain-dump>"` (or `--file <path>`) — ask
  clarifying questions until intent is pinned or the `--budget` (default 6)
  is spent.

## Interviewer

Given a free-text brain-dump, the interviewer works out which of six intent
dimensions the dump already covers, then asks one clarifying question per
remaining gap, in this fixed order:

1. **problem** — what is broken today, and what does it cost?
2. **audience** — who has this problem?
3. **outcome** — what is true once this is solved?
4. **scope** — what is the smallest change that delivers it?
5. **nonGoals** — what are we explicitly not doing?
6. **constraints** — what constrains this?

It never re-asks a dimension, and it terminates deterministically with one of
three stop reasons:

- `pinned` — every dimension is covered by the dump or a substantive answer.
- `budget-exhausted` — the question budget was spent before every gap closed.
- `no-questions-left` — every remaining gap was already asked and declined.

## ADR home

The product app records its architecture decisions in the repo-root
[`docs/adr/`](../../docs/adr/README.md) — the single shared monorepo ADR home.
`@on-par/adr-kit`'s numbering is per-directory (it maxes over the numbers
already present in a directory), so a second ADR home under
`packages/product` would mint a second, colliding "ADR-0005" and make every
cross-reference ambiguous. One home means one numbering namespace.
