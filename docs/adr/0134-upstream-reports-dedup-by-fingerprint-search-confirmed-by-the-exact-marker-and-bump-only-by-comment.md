# ADR-0134: Upstream reports dedup by fingerprint search confirmed by the exact marker, and bump only by comment

- Status: Accepted
- Date: 2026-10-02

## Context

Upstream factory reports are filed on the public factory repo with outside operators' GitHub auth. GitHub
silently drops labels on issues created by users without triage access, so label-filtered dedup
(`listForRepo` with `labels: bug`) never finds those reports. Editing another user's issue body returns 403
for non-collaborators, so the target-repo bump (rewrite the fp-count marker with `updateIssue`) cannot work
upstream. The search API is rate-limited and eventually consistent.

## Decision

`sendUpstreamReports` dedups each report through `FilingGitHubClient.searchIssues`, which queries
`search/issues` with `repo:<owner>/<repo> is:issue in:body "<fingerprint>"`. Results are kept when the issue
is open or was closed within `recentlyClosedDays` (default 30). A result counts as a match only when its body
contains `upstreamReportMarker(fingerprint)` exactly; the lowest-numbered match wins. On a match the sender
adds one occurrence comment and returns `bumped`. It never calls `updateIssue`. A bump does not count toward
the per-operator caps, which still gate before the search. A search or comment failure sends the report to
the outbox like a create failure. Target-repo bugs keep label-based dedup and the body-count bump in `fileBug`.

## Consequences

Reports dedup across operators without labels or collaborator rights. Occurrence counts live only in
comments. Every send costs one search call, and a search outage outboxes reports instead of filing them. Two
operators reporting within the search indexing lag can still create duplicates. Matching relies on the
visible Fingerprint cell being indexed; the hidden marker only confirms the match.
