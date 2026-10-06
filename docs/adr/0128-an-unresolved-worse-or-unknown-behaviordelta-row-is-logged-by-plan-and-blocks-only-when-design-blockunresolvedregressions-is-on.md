# ADR-0128: An unresolved worse/unknown behaviorDelta row is logged by PLAN and blocks only when design.blockUnresolvedRegressions is on

- Status: Accepted
- Date: 2026-10-01

## Context

PLAN's design artifact gained a behaviorDelta table (#1821), and the PLAN prompt tells the planner to fix any row with verdict worse or unknown, or list it in openQuestions (#1830). Until now nothing enforced that, and the other design checks (design_shallow, design_artifact_invalid, design_open_questions) are all log-only. Operators want a signal by default and the ability to stop risky plans before BUILD. The factory runs unattended, so a new hard stop must not be on by default. A later CHECK-phase regression reviewer (#1798) needs the same definition of "unresolved".

## Decision

`findUnresolvedRegressions` in `packages/core/src/design/index.ts` is the single owner of the rule. A behaviorDelta row is unresolved when its verdict is `worse` or `unknown` and no openQuestions entry contains the row's `input` (trimmed, case-insensitive substring). planPhase logs one `design_regression_unresolved` warn event per unresolved row. It stops PLAN with `ok: false` only when `design.blockUnresolvedRegressions` is true. That value is resolved by `resolveDesignRegressionBlock`, and `FACTORY_DESIGN_BLOCK_REGRESSIONS=1/0` overrides it. The packaged default is false, so the check is log-only. New code that needs to know whether a regression row is unresolved must call this helper and must not add its own rule.

## Consequences

Operators get a per-row log signal immediately and can opt into a hard gate per repo or per run. The input-substring rule is lenient: a question that merely mentions the input counts as resolution, so an unhelpful question can satisfy the gate. That trade is accepted to avoid false blocks on prose questions. A plan with no behaviorDelta, such as the fast path, is never affected. Changing the rule later changes both the PLAN gate and any CHECK reviewer that reuses it.

References: issue #1819, parent #1797.
