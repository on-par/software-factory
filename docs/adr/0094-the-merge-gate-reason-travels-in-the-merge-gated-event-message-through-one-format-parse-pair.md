# ADR-0094: The merge-gate reason travels in the merge-gated event message through one format/parse pair

- Status: Accepted
- Date: 2026-09-12

## Context

`waitForMerge` (packages/cli/src/cli/index.ts) refuses to auto-merge a PR whose issue
carries the configured self-fix guard label and emits a `merge-gated` event, but the
operator-facing TUI showed such a lane as an ordinary "waiting to merge" — the operator
could not see that a human must approve, nor which label or policy was responsible (#1394,
epic #1379). Closing that gap needs the reason to reach the TUI. `FactoryEvent` already
carries structured optional sidecars (`rework`, `readiness`, …), so a `mergeGate?` field
plus `logEvent`/`createLogger` plumbing was the obvious alternative; it touches the event
type, the logger meta whitelist and every reader, and still needs a message fallback for
the `merge-gated` lines already written to `.factory/events.ndjson`. Weighed against that,
the failure mode of message parsing is the deciding factor: the gate decision itself lives
in `isAutoMergeBlocked`, so a parse miss can only degrade the *display*, never let a
guarded PR merge.

## Decision

The `merge-gated` event message is the wire format for the merge-gate reason, and
`packages/core/src/filing/policy.ts` owns both ends of it. `mergeGateMessage(label)` is the
only place that renders the message and `parseMergeGateMessage(msg)` is the only place that
reads it back, returning `{ label, policy: 'filing.selfFixLabel' }`; both are exported on
`@on-par/factory-core`'s root public API (ADR-0004) so the TUI never reaches into
`./internal`. `waitForMerge` formats through the helper; the TUI's `reduceDashboard` parses
through it into `LaneState.mergeGate`. No emitter or reader hand-writes or regex-matches
that sentence anywhere else, and the message text stays byte-identical to the one shipped
before this change so historical event logs keep parsing. A structured `FactoryEvent` field
is the migration path if a second consumer ever needs machine-readable gate data; it would
supersede the parse half, not the format half.

## Consequences

Positive: one small, additive diff; historical `.factory/events.ndjson` files render the new
"human approval required" indicator on replay; the operator-facing string and the parser
can never drift apart because one module owns both; the merge decision path is untouched,
so this change cannot make a guarded PR mergeable.
Negative: the message text is now a contract, not free-form prose — editing the sentence
without updating the pair silently degrades the TUI back to a plain "waiting to merge", so
the round-trip test in `policy.test.ts` is load-bearing. The reason is also limited to what
the sentence carries (one label plus the implied policy key); richer gate data will need
the structured-field migration above.

## References

- [Issue #1394 — Self-healing: show merge safety gates for self-fix PRs](https://github.com/on-par/software-factory/issues/1394)
- [Epic #1379 — Self-healing](https://github.com/on-par/software-factory/issues/1379)
- [ADR-0004 — A narrow public API for @on-par/factory-core](docs/adr/0004-narrow-public-core-api.md)
