# @on-par/product

The product app — the **proposer** half of the product family. It turns a PM's
brain-dump into engineering-ready issues. It is **read-only**: it proposes, it
never writes the target codebase.

This package is private and is never published to npm.

## Status

The foundation slice (#469) shipped a runnable `product --help` CLI skeleton.
Story #470 added the Interviewer: given a PM's brain-dump, it asks
clarifying questions until intent is pinned. Story #471 added the Intent
Doc — the canonical artifact built from a pinned interview. This story
(#472) adds the Decomposer: it expands an approved intent doc into an Epic
plus INVEST stories. Later stories in epic #463 fill in the persona panel,
judge/rework loop, readiness report, export, epic architecture design, and
ADR reader.

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
- `product decompose --text "<brain-dump>" --approve "<name>"` (or
  `--file <path>`) — run the interview, approve the intent doc as that named
  PM, then decompose it into an Epic plus INVEST stories and print the
  rendered decomposition; `--approve` is required, and the command fails
  with the approval or decomposition blockers when either gate refuses.

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

## Decomposer

`product decompose` expands an **approved** Intent Doc into one **Epic**
plus a set of **INVEST stories**, each a **vertical slice** with
**Given/When/Then acceptance criteria**. This package is the repo's single
home for INVEST, Gherkin, and vertical-slicing rules — they are not
duplicated anywhere else.

- **Slice axis** — every `scope` statement (`scope` is literally "the
  smallest change that delivers the outcome") becomes one vertical slice,
  and every slice shares the doc's `audience`/`outcome`/`constraints`/
  `nonGoals` context. A slice whose scope text names layer-only work (e.g.
  "refactor", "schema only", "wire up the API") is rejected as horizontal,
  not vertical.
- **INVEST gate** — each emitted story must pass six predicates before it
  is ever produced: **I**ndependent (no dependency cues like "blocked by"),
  **N**egotiable (has an out-of-scope boundary), **V**aluable (traces to
  intent and has a "so that"), **E**stimable (has acceptance criteria and a
  verification step), **S**mall (at most 5 in-scope items and 5 acceptance
  criteria), and **T**estable (every criterion has a When and a Then). Any
  violation blocks decomposition with a message naming the offending letter
  and story.
- **Traceability is total by construction** — stories claim every `scope`
  statement ID, the epic claims every other statement ID, and every
  acceptance criterion cites the statement IDs behind its Given/When/Then.
  Their union is every statement in the doc, so `checkTraceability` always
  reports no `unknownIds` and no `untracedIds` for a decomposition this
  module produces.

The decomposer is pure and deterministic — no model calls, no repo access:
`filesLikelyTouched` stays `[]` and verification steps are `manual: confirm
<outcome>` placeholders until repo context lands in a later story.

## ADR home

The product app records its architecture decisions in the repo-root
[`docs/adr/`](../../docs/adr/README.md) — the single shared monorepo ADR home.
`@on-par/adr-kit`'s numbering is per-directory (it maxes over the numbers
already present in a directory), so a second ADR home under
`packages/product` would mint a second, colliding "ADR-0005" and make every
cross-reference ambiguous. One home means one numbering namespace.
