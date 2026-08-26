# ADR-0045: GitHub queue order is explicit per-lane label metadata

- Status: Accepted
- Date: 2026-08-25

## Context

GitHub issue numbers are incidental identifiers, not a dependency-order signal. The local queue
previously stored the intended sequence as ordered lines, but GitHub queue discovery in #824/#825
discarded that information by sorting candidates numerically. Dependency-sensitive recovery queues
therefore need an ordering representation that lives with the GitHub-backed queue and survives
process restarts and migration away from the local file. ADR-0044 already constrains the ownership
claim protocol and currently names numeric candidate ordering, so this decision replaces only its
ordering rule rather than weakening its label-CAS safety guarantees.

## Decision

Store a positive, one-based execution position as a dedicated factory order label on every queued
issue. Positions are interpreted independently within the issue's factory lane. GitHub queue list
and claim operations rank by that label and fail closed for missing, malformed, or duplicated lane
positions; they never use issue number as an ordering fallback.

Provide a CLI migration that derives each lane's positions from the existing local queue file and
applies queued, lane, and order labels without rewriting the source file. Keep the ADR-0044
`factory:in-progress` and `factory:claimed-by:*` compare-and-set/read-back protocol unchanged.

This ADR supersedes only ADR-0044's candidate-ranking sentence.

## Consequences

GitHub carries complete, reviewable ordering metadata and local dependency-sensitive queues can
move without reordering. Operators must assign valid order labels when manually queuing work, and
a malformed ordered lane becomes visible and blocked rather than being processed in an accidental
numeric order. The migration is additive and retryable because it preserves the local file, but it
requires GitHub label mutations for each queued issue.

## References

- [Issue](https://github.com/on-par/software-factory/issues/833)
- [ADR-0044 — Claiming a queued issue is a label CAS verified by re-fetch](https://github.com/on-par/software-factory/blob/main/docs/adr/0044-claiming-a-queued-issue-is-a-label-cas-verified-by-re-fetch-and-the-smallest-claimant-id-wins.md)
