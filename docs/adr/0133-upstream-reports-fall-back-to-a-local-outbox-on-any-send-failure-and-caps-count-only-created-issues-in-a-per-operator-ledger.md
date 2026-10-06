# ADR-0133: Upstream reports fall back to a local outbox on any send failure, and caps count only created issues in a per-operator ledger

- Status: Accepted
- Date: 2026-10-02

## Context

Upstream factory reports (#1809, ADR-0132) are sent with the operator's own GitHub auth, resolved for
the target repo (GH_TOKEN or `gh auth token`). That auth often has no right to create issues on
on-par/software-factory, or it is missing, or GitHub is briefly unavailable at the end of a run. A
report that is lost or that throws at the end of a run is worse than one that waits. The operator caps
`filing.maxPerRun` and `filing.maxPerDay` must also hold across separate `factory run` processes, so
an in-memory counter is not enough.

## Decision

`sendUpstreamReports` in `packages/core/src/filing/upstream-send.ts` is the only code that sends
upstream reports. It sends only `buildUpstreamReport` output and always with `labels: []`. A missing
client or any `createIssue` failure writes the report to the outbox (`writeUpstreamOutbox`, one
`<fingerprint>.json` per report, default `~/.factory/filing/outbox`) and logs `upstream_report_outboxed`
with a reason from `classifyUpstreamSendError`. The function never throws for a send failure. Caps use
the existing `FilingLedger` rules, persisted per operator at `~/.factory/filing/upstream-ledger.json`.
Only a created issue counts against them, `filedThisRun` resets on each call, and a capped report is
dropped and logged as `upstream_report_skipped`, never outboxed.

## Consequences

Reports survive missing rights and transient failures, and an outbox flush (#1859) can send them later.
The daily cap holds across processes on one machine but not across machines for the same operator. Two
concurrent runs may race the ledger and overshoot a cap by one, which is accepted because the ledger is
best-effort. Capped reports are not recoverable from the outbox. Their fingerprint and evidence remain
only in the local event log.

## References

- [Issue #1860](https://github.com/on-par/software-factory/issues/1860)
- [Parent issue #1809](https://github.com/on-par/software-factory/issues/1809)
