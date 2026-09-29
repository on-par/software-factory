# ADR-0113: The review verdict blocks only on deterministic checker failures and unmet non-advisory criteria

- Status: Accepted
- Date: 2026-09-29

## Context

`factory review` (epic #1667, story #1670) must grade a PR as approve, approve with comments, or request
changes, and explain why. Deterministic checkers (compile, tests, lint, links, accessibility) produce
reproducible PASS/FAIL results; agent-backed and custom checkers (design smells, constitution custom
checkers, fail-closed unknown checkers) are judgement calls that can be noisy. Human reviewers respond very
differently to a failing test than to an advisory nit, so the verdict must separate hard failures from
advisory ones and must be reproducible from its inputs alone.

## Decision

`computeReviewVerdict` in `packages/core/src/review/verdict.ts` is the single, pure owner of the mapping.
`request changes` is reached only by a FAIL from a checker in `DETERMINISTIC_CHECKERS` or by an acceptance
criterion with status `unmet`. A FAIL from any other checker, an advisory criterion, a SKIP of a checker the
constitution requires, or `thin` context caps the verdict at `approve with comments` and is listed in the
reasons. Anything else is `approve`. Reasons list only the tier that decided the verdict. Severity rules
are not configurable per repo.

## Consequences

Verdicts are reproducible and explainable, and an agent checker's false positive can never block a PR on
its own. The trade-off: a genuine problem found only by an agent checker is surfaced as a comment, not a
block, so a human still has to read approve-with-comments reasons. Adding a checker to the blocking set,
or making severity configurable, means changing `DETERMINISTIC_CHECKERS` or superseding this ADR.

## References

- [Issue](https://github.com/on-par/software-factory/issues/1679)
- [Story](https://github.com/on-par/software-factory/issues/1670)
