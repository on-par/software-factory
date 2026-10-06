# ADR-0154: A regression hunt runs only for review-floor class B/C diffs and reports class A as a SKIP with its reason

- Status: Accepted
- Date: 2026-10-02

## Context

Every CHECK checker asks whether a change does what the spec says. None asks whether the change makes some
input worse than before. When the tests share the plan's blind spot, full coverage and green checkers cannot
catch the regression. That happened on leantechniques/agent-ready-assessment#194: all seven checkers passed,
and a human then found an npm-shrinkwrap-only repo where the new install command was worse (#1798). An
LLM regression hunt closes the gap, but it is a model call per CHECK round with an open-ended search, and it
can run real tools. Paying that on every trivial diff is waste. The A/B/C review floor
(`computeReviewFloor`, packages/core/src/review/floor.ts) already classes a diff's risk deterministically
from its paths and size. Before this, the floor had no caller in CHECK. A checker whose result, findings or
skip reason are invisible in reports cannot be audited, and a skipped hunt that reads as a pass would
overstate the evidence.

## Decision

The built-in `regression_hunt` checker, registered after `design_smells`, runs only when the review floor
classes the CHECK diff as B or C. For a class A diff, or when `FACTORY_REGRESSION_HUNT=0`, it returns
`SKIP` with a reason that names the cause (the floor class, or the kill switch). It never returns `PASS`,
so the check summary counts it under `skips`. Its findings are carried as structured
`CheckerOutput.findings` entries (`RegressionFinding`: input, before, after, evidence, reproduced), not
only as `details` text. `renderCheckerFindings` (packages/core/src/checkers/index.ts) is the single
formatter for them. CHECK's summary log and the evidence pack's Checker verdicts section both render
findings through it, without truncating input, before or after.

## Consequences

Class B/C diffs, the risky ones, get an adversarial "is any input worse" pass, and every finding is auditable
in the PR's evidence pack and the CHECK log. Class A diffs skip the cost, and the skip is visible as a skip
with its reason. The hunt's coverage is only as good as the floor's classing: a risky change that the floor
calls A is not hunted. That is accepted because the floor fails toward B/C and repos can add C rules
(ADR-0151). CHECK now depends on the review floor, so floor rule changes alter which diffs are hunted.
Other checkers can reuse the structured findings field, but its shape is the regression-finding shape. A
checker with differently shaped findings needs a new field, not a reinterpretation of this one.

## References

- [Issue #1798 — regression_hunt checker](https://github.com/on-par/software-factory/issues/1798)
- [Issue #1839 — show regression_hunt in the evidence pack and record the ADR](https://github.com/on-par/software-factory/issues/1839)
