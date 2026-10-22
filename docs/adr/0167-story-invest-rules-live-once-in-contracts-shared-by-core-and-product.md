# ADR-0167: Story INVEST rules live once in @on-par/contracts, shared by core and product

- Status: Accepted
- Date: 2026-10-21
- Supersedes: ADR-0010
- Issue: #3447

## Context

ADR-0010 re-implemented the INVEST predicates and the 5/5 "small" thresholds inside core because #605 kept the private product package out of scope. Product kept its own `checkInvest`, and only "MUST change together" comments kept the two copies in step. Both copies already take the contracts `Story`, both packages already depend on `@on-par/contracts`, and ADR-0165 made the 5/5 counts a `size_hint` rather than a gate.

## Decision

`@on-par/contracts` owns the six predicates (`checkStoryInvest`), the thresholds (`MAX_IN_SCOPE_ITEMS`, `MAX_ACCEPTANCE_CRITERIA_ITEMS`) and the `InvestLetter`, `InvestViolation` and `InvestReport` types. Core and product import them and keep no copy. Core keeps its raw-Markdown `checkIssueSize`, which reads the shared thresholds, and still never depends on product.

## Consequences

- A rule change happens in one file, so core's readiness gate and product's decomposer and judge cannot drift.
- Contracts needs a release alongside core; lockstep versioning already provides this.
- No threshold, predicate or reason wording changes.
