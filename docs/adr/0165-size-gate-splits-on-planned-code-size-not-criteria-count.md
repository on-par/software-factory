# ADR-0165: The size gate splits on planned code size, not on in-scope or acceptance-criteria count

- Status: Accepted
- Date: 2026-10-20
- Amends: [ADR-0010](0010-size-gate-decomposes-oversized-issues-before-plan.md), [ADR-0147](0147-size-gate-slice-mode-ships-an-oversized-issue-as-sequential-slice-prs-under-the-same-issue-instead-of-filing-sub-issues.md) (what triggers a split; what happens after a split is unchanged)
- Issue: #3350

## Context

The size gate decided to split an issue by counting how it was written. Before PLAN, `checkIssueSize` tripped on more than 5 in-scope bullets or more than 5 acceptance-criteria checkboxes, and `planPhase` then sliced the issue or filed sub-issues. After PLAN, the build-scope gate tripped on more than 6 target types, 8 signatures or 10 call edges, and never looked at files or bytes. A cohesive change with 7 in-scope items and 10 criteria that touched 3 small files was split into 3 overlapping slice PRs.

## Decision

1. In-scope and acceptance-criteria counts are a hint only. When they exceed 5, `planPhase` logs a `size_hint` warn event and continues to model PLAN. It no longer slices or decomposes before PLAN. An existing trusted slice plan on the issue is still honoured in slice and stack mode.
2. The post-plan gate splits on `estimatePlanSize`. The estimate counts the distinct files the design artifact changes or adds, and estimates tokens from the byte size of every file it names (changed, read and colocated tests) divided by 4, plus a fixed output allowance per changed file. The gate splits when estimated tokens exceed `sizeGate.tokenBudget` (default 150000) or changed files exceed `sizeGate.maxFiles` (default 12). A plan that changes 3 files or fewer never splits.
3. `MAX_BUILD_TARGET_TYPES`, `MAX_BUILD_SIGNATURES` and `MAX_BUILD_CALL_EDGES` are removed. Type, signature and call-edge counts no longer gate.

ADR-0156 and ADR-0161 still govern what happens once a split is decided.

## Consequences

- A cohesive change with many criteria plans as one PR.
- A genuinely large plan still splits, and the reason names the estimate and the budget.
- The estimate is deterministic and testable; it does not rely on a model's self-reported size.
- `readiness.sizeOk`, KPIs and `factory ready-check` still read the 5/5 counts unchanged.
