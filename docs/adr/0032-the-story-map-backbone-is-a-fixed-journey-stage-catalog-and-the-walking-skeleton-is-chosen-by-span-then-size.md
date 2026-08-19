# ADR-0028: The story-map backbone is a fixed journey-stage catalog, and the walking skeleton is chosen by span-then-size

- Status: Accepted
- Date: 2026-08-19

## Context

Story mapping needs a backbone — an ordered set of user activities the journey passes
through — before it can cut horizontal releases. The product package is pure by ADR-0006
(`planExport`/`buildDesignBundle` take no network, clock, or fs dependency) and every
function in `decompose/` today is a deterministic, unit-testable transform of the Intent
Doc. That rules out inferring the backbone with a model at decompose time. It also rules
out deriving stage order from the doc itself: the Intent Doc's statement order is exactly
the arbitrary order this issue exists to replace, so bootstrapping the backbone from it
would be circular.

Separately, "the smallest slice that exercises the whole journey end-to-end" has no unique
mechanical reading when each slice is one scope statement. Without a frozen rule, two
correct-looking implementations would flag different slices, and the "exactly one walking
skeleton" invariant would be untestable.

## Decision

`packages/product/src/decompose/story-map.ts` owns an ordered `JOURNEY_STAGES` catalog —
`access → discover → capture → process → deliver → learn`, plus a terminal `other` — where
each stage carries lowercase substring cues, the same shape and matching discipline as
`interview/dimensions.ts`'s `DIMENSION_PROBES`. `buildStoryMap` places each scope statement
on its earliest matching stage, admits a stage to the backbone when a scope statement sits
on it or an outcome statement mentions it, and compacts ranks 1..n in catalog order.

The walking skeleton is selected by a total, four-key comparator over the doc's slices:
most distinct journey stages spanned (desc), then earliest backbone rank, then fewest words
in the scope text, then doc order. The winner is release 1 and is emitted first; every other
slice's release is `2 + the index of its backbone rank among the ranks still holding slices`,
so slices on one journey step ship together. The catalog and the comparator are product
judgment frozen as data and code — they are meant to be tuned against real Intent Docs, not
re-derived per call site.

## Consequences

Positive: `planSlices` stays a pure function of the Intent Doc, so the whole story-mapping
pass is covered by fast unit tests with no fixtures beyond a doc literal. The "exactly one
walking skeleton" invariant is decidable and therefore assertable. The catalog is one
readable list a product person can tune without touching the ordering algorithm.

Negative: the cue catalog is English-language and domain-neutral, so a doc phrased outside
its vocabulary collapses onto the terminal `other` step and degrades to something close to
doc order. That is a deliberate, visible failure mode — `other` always ranks last and is
labelled `Unmapped` — rather than a silent one. Tuning the catalog changes the emitted story
order for existing docs, so catalog edits are behavior changes and need test updates.
Cue matching is substring-based and can over-match, which is why stage assignment takes the
earliest catalog match rather than trying to resolve ambiguity.

## References

- [Issue #633 — product: story-mapping and walking-skeleton ordering in decompose](https://github.com/on-par/software-factory/issues/633)
- [ADR-0006 — Proposer export is pure; GitHub filing goes through an injected port](https://github.com/on-par/software-factory/blob/main/docs/adr/0006-proposer-export-is-pure-github-filing-goes-through-an-injected-port.md)
- [ADR-0010 — The readiness size gate re-implements the INVEST "small" rule inside core](https://github.com/on-par/software-factory/blob/main/docs/adr/0010-the-readiness-size-gate-re-implements-the-invest-small-rule-inside-core.md)
