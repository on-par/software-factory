# ADR-0135: Incoming upstream factory reports are labeled for triage by a marker-gated workflow that never queues work

- Status: Accepted
- Date: 2026-10-02

## Context

Upstream reports (ADR-0132..0134) are filed by outside operators' factories. GitHub drops labels an issue
author without triage rights tries to set, so the sender files with `labels: []` and reports arrive unlabeled
and unfilterable. These reports are untrusted outside input: the always-on factory claims any open issue
labeled `factory:queued` plus a lane label, so anything that applied those labels automatically would let an
outsider queue work without the secure intake approval (#1802, #1804).

## Decision

`.github/workflows/triage-factory-reports.yml` runs on `issues: opened` and delegates to
`scripts/triage-factory-report.sh`. It adds exactly `bug`, `factory:auto-filed` and `factory:needs-triage`,
and only when the body has a line that exactly matches
`<!-- factory-upstream-report v1 fp:[A-Za-z0-9_-]{1,64} -->`, the format of `upstreamReportMarker`. It never
adds `factory:queued`, `factory:lane:*`, `factory:order:*` or any other label, and it runs no agent. The issue
body reaches the script only through an environment variable. Approving or queueing a report stays a human
action through the secure intake.

## Consequences

Reports can be filtered by label and cannot be claimed by the factory until someone approves them. Changing
the marker format in `upstreamReportMarker` now also requires changing the script's regex and its test. Anyone
can open an issue with a hand-written marker and get the three triage labels. That costs only triage noise,
because none of the labels queues work.
