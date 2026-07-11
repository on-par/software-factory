---
product: example-data-app
version: 1
checkers:
  - compile
  - tests
  - lint
  - custom_data_verification
  - custom_report_validation
enforced_on: [plan, build, check]
---

# Example Constitution — Data Analysis App

> Example constitution demonstrating custom data-integrity checkers — the case
> where reported numbers must be grounded in the underlying data.

## Purpose
An app that analyzes an input dataset and produces a report with scores,
recommendations, and a narrative. Demonstrates checkers that verify reported
values against the source data so nothing is fabricated.

## Standards

### Data Integrity
- All reported values must match the measured/input data — no fabricated numbers
- Recommendations must be grounded in the measured data (if the data shows a peak
  at some value, a recommendation must not contradict it)
- Scores must be computed from the actual analysis, not synthesized
- Input metadata (size, format, counts, duration) must match the source file

### Report Quality
- Every report must include: an overall score, per-category scores, recommendations,
  and a narrative
- Scores must be on the defined scale and match the scoring rubric
- The narrative must reference specific measured values, not generic advice
- Recommendations must be actionable and specific, not vague

### Input Handling
- Parsing must handle each supported input format
- Diffs between inputs must show exact changes (field, old value, new value)
- No values may be fabricated — all must come from the parsed input

### Code Quality
- Type checking must pass with no errors
- All public functions must have doc comments
- Analysis functions must be deterministic (same input → same output)
- No floating-point comparisons without epsilon tolerance

## Quality Gates
1. `compile` — Builds without errors
2. `lint` — Linting passes
3. `tests` — Test suite passes (including fixture-based analysis tests)
4. `custom_data_verification` — Report values match the measured/input data
5. `custom_report_validation` — Report has all required sections and references real data

## Dispute Rules
- If the data-verification checker flags a number as "not matching the data," the
  worker must show the calculation chain. If the calculation is correct and the
  checker used the wrong reference data, the checker is overruled.
- If the report-validation checker flags a narrative as "too generic," the boss
  compares against the measured values. If the narrative references specific
  numbers that appear in the data, it passes.
- Scoring-rubric disputes: the boss reads the rubric in the spec. The rubric is
  the source of truth, not the checker's interpretation.

## Non-Goals
- Real-time/streaming analysis — this example covers batch input only
- Any platform-specific or hardware-specific handling
- UI/responsive design — not in scope for this example
