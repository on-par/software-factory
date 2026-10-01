# ADR-0122: Repo classifier config may add C rules and redefine the A scope, but never remove a packaged C rule

- Status: Accepted
- Date: 2026-10-01

## Context

#1723 lets a repo override the deterministic review floor through a `classifier` config section (`alwaysHuman`, `autoEligible`, `maxDiffLines`). ADR-0121 requires that the floor may only escalate and that changes to the classifier, its policy and merge/land code are always class C. The usual "repo value replaces packaged default" semantics would let a repo config drop those C rules. The PR classifier also needs its own pinned model so that a model change is a deliberate config edit. That pin must not move the checker routes, which share the `checker` tier.

## Decision

`applyReviewFloorOverrides` (`packages/core/src/review/floor.ts`) merges a repo's classifier section onto the packaged rules as follows:

- `alwaysHuman` adds one class-C rule (`repo-always-human`). Every packaged C rule is kept.
- `autoEligible`, when set, replaces the packaged class-A rules with one rule (`repo-auto-eligible`).
- `maxDiffLines`, when set, replaces `maxLines`.
- An unset key keeps the packaged value.

An entry with `*` or `?` is a glob. Any other entry is a case-insensitive path prefix.

`models.pins.classifier` is checked in `applyRepoConfig` like the other pins. It applies only when the `classify_pr` route resolves, through `resolveClassifierModel`, and never rewrites the `checker` tier. When it is unset, `classify_pr` resolves through the `checker` tier.

## Consequences

Positive: no repo config can loosen the packaged C floor, so ADR-0121's always-C guarantees hold in every repo. A classifier model change is visible as a diff to `models.pins.classifier`.

Negative: a repo cannot opt out of a packaged C rule it finds too strict, for example the `sensitive-name` pattern. Doing that needs a packaged-default change. `autoEligible` can still widen A scope, so a repo owner can make more paths A-eligible through a human-reviewed config change. Later code must not add a config path that deletes packaged C rules.

References: ADR-0121, issue #1723.
