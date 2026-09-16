# ADR-0106: A duplicate-decomposition story blocks the entire filing batch, not just itself

- Status: Accepted
- Date: 2026-09-16

## Context

The 2026-09-15 backlog audit found roughly ten concerns re-decomposed two or three times
each under the same parent epic, because PLAN's decomposition step (`decomposeOversizedIssue`
/ `fileDecomposition` in `packages/core/src/readiness/decompose.ts`) has no memory of what it
already filed. A re-run over the same oversized issue proposes a fresh epic + story set from
scratch and, when `fileSubIssues` is set (ADR-0043's pre-flight gate path), files every story
as a new linked sub-issue regardless of what already exists under the parent.

Closing that requires a pre-file duplicate check against the parent's existing open sub-issues.
Once a check exists, a choice remains for what happens when it fires and only *some* of the
proposed stories match an existing sibling: file the ones that don't match and skip only the
duplicates, or refuse to file anything from that decomposition run. The two options trade off
differently. Filing the non-duplicate remainder maximizes forward progress on a single run, but
a decomposition batch is not a set of independent stories — `epic.children` declares a build
order, `story.sequencing` narrates position within that order ("second slice", "story 2 of 3"),
and each story's INVEST validation already runs over the *whole* batch before anything is filed
(`validateDecomposition`). Silently dropping one story from the middle of a declared sequence
produces a build order with a hole in it, sequencing text that references a story that was never
filed, and a set of children that no longer matches what the epic comment on the parent
describes — a partially-filed decomposition that reads as more confusing than the duplicate it
was trying to prevent.

## Decision

When `findDuplicateStory` (readiness/duplicate-guard.ts) reports any proposed story as similar
(Jaccard similarity on rendered title+body >= 0.5) to an existing open sub-issue of the parent,
`fileDecomposition` blocks the entire batch: no story is created, a warning comment is posted on
the parent issue naming the matching story and its existing sibling, a `decompose_duplicate_skipped`
event is logged, and the function returns `[]` — the same empty-childIssues shape a create failure
or a failed sibling-listing fetch already returns. The caller (`decomposeOversizedIssue`) does not
distinguish this from any other filing failure; the comment on the parent carries the
duplicate-specific detail.

This mirrors the batch-or-nothing posture `fileDecomposition` already has for a mid-batch create
failure ("a partially filed decomposition must never read as success") and extends it to the
duplicate case for the same reason: a decomposition's stories are a declared, ordered set, not
independent proposals.

## Consequences

Positive: a re-decomposition of an already-decomposed epic never produces a half-filed,
sequence-broken batch; the warning comment gives a human exactly what to look at (which proposed
story matched which existing sibling) to decide whether to re-run decomposition, edit the epic
manually, or leave the existing children as-is.

Negative: one spuriously-matching story (a false positive at the 0.5 threshold) blocks filing for
every other story in the same batch, even ones that are genuinely new. That is bounded by the
same fail-closed posture ADR-0018 already established for unverified GitHub listings in this
codebase: an unnecessary abort costs one skipped decomposition run that a human can re-trigger
after review, while filing a partial, sequence-broken batch is a harder state to clean up by hand.

## References

- [Issue #1502 — Duplicate-decomposition guard: PLAN checks sibling children before filing a new set](https://github.com/on-par/software-factory/issues/1502)
- [ADR-0043 — A tripped pre-flight size gate files sub-issues under the original issue and re-queues them; the post-plan gate still parks](0043-a-tripped-pre-flight-size-gate-files-sub-issues-under-the-original-issue-and-re-queues-them-the-post-plan-gate-still-parks.md)
- [ADR-0018 — A dedup index is never derived from an unverified `gh` listing](0018-a-dedup-index-is-never-derived-from-an-unverified-gh-listing.md)
