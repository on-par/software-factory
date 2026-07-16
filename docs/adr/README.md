# Architecture Decision Records

An ADR is a short record of one significant architecture decision, the
context that drove it, and its consequences — written down at the time the
decision is made, not reconstructed later. This directory follows the classic
[Michael Nygard ADR template](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions).

## When to add one

Add an ADR when a decision:

- **constrains how future code must be written** (e.g. a required pipeline
  shape, a config-as-source-of-truth rule),
- **would be expensive to reverse** (e.g. a data model, a routing
  architecture, a serialization format), or
- **looks arbitrary or wrong from the code alone**, such that an agent or new
  contributor might "fix" it without knowing it was deliberate.

Do **not** write ADRs for reversible implementation details (variable names,
a helper's internal structure, a one-off script) — those belong in code
comments or PR descriptions, if anywhere.

## How

1. Copy the section structure of `0001-boss-worker-checker-pipeline.md`:
   header block (Status, Date) followed by **Context**, **Decision**,
   **Consequences**.
2. Number sequentially: `NNNN-kebab-case-title.md`, using the next free
   number.
3. Status is one of `Proposed`, `Accepted`, `Deprecated`, or `Superseded`.
4. Never rewrite history. To change a past decision, add a new ADR and mark
   the old one `Superseded by ADR-NNNN`.
5. Add a row to the index below.

## Index

| Number                                       | Title                                                     | Status   |
| -------------------------------------------- | --------------------------------------------------------- | -------- |
| [0001](0001-boss-worker-checker-pipeline.md) | Boss–worker–checker pipeline with per-issue build routing | Accepted |
