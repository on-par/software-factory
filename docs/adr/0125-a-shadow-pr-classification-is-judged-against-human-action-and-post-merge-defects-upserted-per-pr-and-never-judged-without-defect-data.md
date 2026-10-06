# ADR-0125: A shadow PR classification is judged against human action and post-merge defects, upserted per PR, and never judged without defect data

- Status: Accepted
- Date: 2026-10-01

## Context

ADR-0121 runs the PR classifier in shadow mode first. A class can only be promoted on published evidence: slipped defects demote, clean streaks are bounded by the rule of three, and the model is dropped if it cannot beat the floor rules. That evidence needs one fixed definition of when a shadow verdict was right. The raw signals already exist: `reconstructHumanEvents` gives human-approved, human-edited and human-abandoned, and `detectPostMergeDefects` emits post-merge-defect events once a PR's defect window has closed. Defect detection calls GitHub and can fail. If a missing defect signal were read as "no defect", it would forge a clean class A streak.

## Decision

`joinClassifierOutcomes` (`packages/core/src/kpis/classifier-outcomes.ts`) is the single owner of the agreement rule. It judges the shadow `modelClass`, never `finalClass`, applying these rules in order:

1. The PR was abandoned (closed without merge): A is `disagree`, B and C are `agree`.
2. The PR is still open, or merged with its defect window still open: `pending`.
3. The window closed and a post-merge defect fired: A is `disagree` with `slipped: true`, B and C are `agree`.
4. The window closed with no defect and a human edited at or before merge: A is `disagree`, B and C are `agree`.
5. The window closed with no defect and no human edit: A is `agree`, B and C are `disagree` (over-escalation).

A classification with a null `modelClass` produces no record. Records live in `.factory/state/classifier-outcomes.jsonl`, upserted by PR number. Final records (`agree`/`disagree`) are frozen once written; only `pending` records are replaced. `factory kpis` computes the join only after defect detection succeeded; when it failed or was skipped, nothing is written.

## Consequences

Positive: every report and promotion decision reads one stable definition, a slip is recorded as soon as the window closes, and missing GitHub data can never fake a clean streak.

Negative: a frozen record does not reflect a defect reported after the window closes. Treating a clean, unedited merge as evidence that B/C over-escalated is a heuristic. A PR re-run after its record froze keeps the old verdict. Changing any rule requires a new ADR and invalidates comparisons with records written under this one.

References: ADR-0121, ADR-0124, issue #1726.
