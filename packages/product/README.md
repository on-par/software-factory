# @on-par/product

The product app — the **proposer** half of the product family. It turns a PM's
brain-dump into engineering-ready issues. It is **read-only**: it proposes, it
never writes the target codebase.

This package is private and is never published to npm.

## Status

The foundation slice (#469) shipped a runnable `product --help` CLI skeleton.
Story #470 added the Interviewer: given a PM's brain-dump, it asks
clarifying questions until intent is pinned. This story (#471) adds the
Intent Doc — the canonical artifact built from a pinned interview. Later
stories in epic #463 fill in the decomposer, persona panel, judge/rework
loop, readiness report, export, epic architecture design, and ADR reader.

## Commands

- `product --help` — usage and the list of available commands.
- `product adr home` — prints the absolute path of the shared monorepo ADR
  home.
- `product adr next "<title>"` — prints the filename for the next ADR in that
  home, numbered by `@on-par/adr-kit`.
- `product interview --text "<brain-dump>"` (or `--file <path>`) — ask
  clarifying questions until intent is pinned or the `--budget` (default 6)
  is spent.
- `product intent --text "<brain-dump>" [--approve "<name>"]` (or
  `--file <path>`) — run the interview and print the Intent Doc built from
  it; with `--approve` the doc is approved as that named PM, or the command
  fails with the reasons approval was refused.

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

## Intent doc

Once the interview pins a brain-dump (or bounds it with open gaps), `product
intent` builds the **Intent Doc** — the canonical artifact every later stage
of the product app grades against. Every intent statement gets a stable,
human-readable ID of the form `INT-<DIMENSION>-<NN>` (e.g. `INT-PROBLEM-01`)
rather than a content hash: a typo fix should not silently rotate the ID and
break every existing reference, and a PM reading the doc should be able to
tell at a glance which dimension a statement belongs to. IDs are stable for
a given interview — rebuilding the doc from the same result yields the same
IDs.

Downstream artifacts — `Story` and `Epic`, defined in `@on-par/contracts` —
carry a `tracesTo` array of these IDs, so a story can literally cite
`tracesTo: ['INT-PROBLEM-01']` and the traceability check can report
references that don't land (`unknownIds`) or intent nothing claims
(`untracedIds`).

The doc starts as a **draft** and only becomes **approved** through human
gate #1: a named PM must approve it, and approval is refused while any
intent dimension is still an open gap.

## ADR home

The product app records its architecture decisions in the repo-root
[`docs/adr/`](../../docs/adr/README.md) — the single shared monorepo ADR home.
`@on-par/adr-kit`'s numbering is per-directory (it maxes over the numbers
already present in a directory), so a second ADR home under
`packages/product` would mint a second, colliding "ADR-0005" and make every
cross-reference ambiguous. One home means one numbering namespace.
