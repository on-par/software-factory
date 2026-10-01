# ADR-0126: The classifier report bounds slips with the rule of three over merged closed-window PRs and prints unknown, never 0%, when there is no evidence

- Status: Accepted
- Date: 2026-10-01

## Context

ADR-0121 lets a named human promote a classifier class only on published evidence, and ADR-0125 persists one judged outcome per PR in `classifier-outcomes.jsonl`. A streak of clean merges on a small sample proves little. If the report showed "0 slips → 0%" or treated abandoned or pending PRs as evidence, a human could promote a class on a sample that cannot support it. The record's `slipped` flag and `verdict` are class-relative, so they cannot build a confusion table across classes.

## Decision

`summarizeClassifierOutcomes` (`packages/core/src/kpis/classifier-outcomes.ts`) is the single owner of the report math. Each record gets one class-independent outcome bucket, in `decideVerdict`'s rule order: abandoned and unmerged → human-gated; unmerged or defect window open → pending; defect fired → slipped defect; human edited before merge → human-gated; otherwise merged clean. A class's evidence count n counts only PRs that merged and whose defect window has closed. With 0 slips and n > 0 the report shows the rule-of-three 95% upper bound min(1, 3/n). With n = 0 it shows "unknown" (null in JSON), never 0%. With slips it shows the observed rate and no bound. Model-vs-floor agreement ranks A < B < C and counts PRs with no floor separately. `factory classifier report [--json]` is read-only.

## Consequences

Small samples show wide bounds; 10 clean merges still read "≤ 30%". The report aggregates across prompt and policy versions; per-version evidence needs a later filtering change. Changing the bucket rules or bound formula changes published evidence and needs a superseding ADR.

References: ADR-0121, ADR-0125, issue #1727.
