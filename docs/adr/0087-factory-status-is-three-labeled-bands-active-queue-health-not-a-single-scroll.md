# ADR-0087: `factory status` is three labeled bands — Active, Queue, Health — not a single scroll

- Status: Accepted
- Date: 2026-09-09

## Context

`factory status` printed Effective config, Provider breaker, the local
queue-file's active claims (labeled `== Queue ==`, despite being local-claim
state, not the claimable backlog — see ADR-0086), Last Events, and Health
KPIs as one continuous run of `== Section ==` headers with no grouping. A
reader scanning for "is anything running right now" had to visually filter
out config/KPI noise to find the one or two active-claim lines (#1344).

Two things were conflated under the single word "Queue": the local
queue-file's in-flight claims (what `partitionLocalQueueByActivity` already
computes) and the actual claimable backlog, which for a GitHub-backed queue
lives in `factory:queued` + `factory:lane:*` labels and is only exposed
today via `factory queue add`/`GithubQueue.lanes()`/`.list()` — `factory
status` never rendered it at all.

## Decision

`factory status` renders exactly three top-level bands, in this order:

1. **`== Active ==`** — a rename-only of the old `== Queue ==` section.
   Same `partitionLocalQueueByActivity` data (lane, issue, phase, age), same
   stale-count line; only the label changes, so it stops claiming to be a
   backlog view and correctly describes in-flight local claims.
2. **`== Queue ==`** — new. Lists only claimable GitHub-backed work, built
   from `GithubQueue.lanes()` + `.list(lane)` (`createGithubQueue` /
   `createOctokitQueueClient`, the same primitives `factory queue add` and
   `runLane` already use). This is claimable-only by construction: claiming
   an issue removes its `factory:queued` label, so a claimed-but-unstarted
   issue never appears here even though it would appear in `== Active ==`
   once a claim's phase snapshot exists. Gated on `hasGitHubToken()` so a
   token-less local checkout degrades to a one-line message instead of
   failing the whole command, matching the existing `cmdWorktreeGc`
   best-effort pattern; a lookup error degrades to a one-line message too,
   rather than crashing `status`.
3. **`== Health ==`** — a rename of `== Health KPIs ==`, now nesting the
   previously-flat Effective config, Provider breaker, Last Events, and KPIs
   sections as indented subsections rather than hiding any of them. Nothing
   in Health is removed or flag-gated (explicitly out of scope for #1344);
   only its position (last) and grouping change.

Active is ordered first because it answers the most time-sensitive
question ("what's running right now"); Queue is second (what's next);
Health is last (diagnostic/background information, read less often).

## Consequences

Positive: a glance at the top of `factory status` answers "is anything
active" without scrolling past config dumps; the previously-invisible
claimable GitHub backlog is now visible without a separate `factory queue`
command. Negative: the Health subsections lose their own top-level `==
==` headers, so any external tooling or docs grepping for `== Provider
breaker ==` / `== Effective config ==` / `== Last Events ==` /
`== Health KPIs ==` verbatim needs updating to the new nested headers
(`Provider breaker:`, `Effective config:`, `Last Events:`, `KPIs:` under
`== Health ==`) — no such external consumer is known to exist today.

## References

- [Issue #1344](https://github.com/on-par/software-factory/issues/1344)
- [ADR-0086](0086-local-queue-entry-staleness-is-judged-from-the-per-issue-phase-snapshot-heartbeat-not-the-queue-files-mtime.md)
