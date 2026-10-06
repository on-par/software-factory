# ADR-0157: An ADR with no status line is treated as Accepted for PLAN's ADR injection

- Status: Accepted
- Date: 2026-10-06

## Context

`readAdrContext` kept an ADR only when its status normalized to `Accepted`. An ADR with no status line has an empty
status, which normalizes to nothing, so it was skipped as inactive.

`leantechniques/agent-ready-assessment` has 6 ADRs that are each just `# Title` plus prose. Across 18 PLAN runs every
one logged `adr_context_empty` and planned with no ADR constraints. The only clue was an `adr_skipped` count with no
file names or reasons. A repo that never writes status lines still lives by those decisions.

## Decision

`readAdrContext` is the single owner of the rule.

- An ADR whose status is empty or whitespace-only is active and carries `statusless: true`.
- Any non-empty status keeps the `normalizeStatus(status) === 'Accepted'` rule. Unrecognised words such as `Draft` or
  `WIP` are inactive, as are Proposed, Rejected, Deprecated, and Superseded.
- The PLAN `adr_context` log marks each such ADR `(no status, treated as Accepted)`, and the prompt renders it the same
  way.
- The PLAN `adr_skipped` log names every skipped file with its reason, `unparsable` or `inactive`.
- The `@on-par/adr-kit` parser and `normalizeStatus` do not change.

## Consequences

`design_smells` and the review classifier read the same context, so they see these ADRs too. A stray status-less
markdown file with an H1 in `docs/adr` now becomes a constraint. README, index, and template files are still excluded.

Repos that already write status lines see no change.
