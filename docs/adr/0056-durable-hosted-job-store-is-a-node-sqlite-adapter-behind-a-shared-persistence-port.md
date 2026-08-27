# ADR-0056: Durable hosted job store is a node:sqlite adapter behind a shared persistence port

- Status: Accepted
- Date: 2026-08-27

## Context

ADR-0048 established the hosted job store as in-memory only and explicitly noted
"durability here is a logical guarantee, not persistence across process restarts." Issue
#939 makes crash-durability the first blocker on the hosted path: a cloud factory must
survive restarts. Two forces shape the choice. First, the lease/terminal invariants (one
active lease per job, immutable terminal state, harmless duplicate terminal updates, no
re-lease of terminal jobs, no mutation from expired leases) are subtle and order-dependent
(ADR-0048); a second adapter must not re-derive them or the two backends will drift. Second,
core keeps its dependency surface tight (config is zero-dep; core depends only on
execa/octokit/gray-matter/zod), so adding a native SQLite build dependency is undesirable.
Core's engines.node is >=24, where node:sqlite (DatabaseSync) is built in.

## Decision

Extract the entire idempotency/lease invariant body into one internal seam —
createHostedJobStoreOverPersistence(persistence, {now}) over a HostedStorePersistence port
(job and runner get/put/list). The existing in-memory Map becomes one persistence impl
(createHostedJobStore keeps its signature and stays the default), and a new SQLite impl uses
the built-in node:sqlite with two JSON-blob tables (jobs, runners) keyed by id and a PRAGMA
user_version versioned bootstrap — no external dependency, no migration framework. Adapter
selection is configuration-driven via resolveHostedJobStore and defaults to memory. The clock
stays injected in both adapters. Postgres and backup/restore tooling are explicitly out of
scope; a future Postgres adapter implements the same HostedStorePersistence port.

## Consequences

Positive: the invariants have exactly one implementation, so "one contract, two adapters" is
structural, not cosmetic; core gains crash-durability with zero new runtime dependencies; a
future durable backend (Postgres) is a drop-in persistence impl. Negative: node:sqlite is
still marked experimental on Node 24 and emits a process warning; the JSON-blob schema is not
queryable relationally (all filtering happens in JS after loading rows), which is adequate
for the MVP's small job volume but would need revisiting at scale; a crash between the
job-write and the runner-write of a single terminal transition can leave runner.available
briefly stale until the next heartbeat, an accepted MVP tradeoff.

## References

- [Issue #939](https://github.com/on-par/software-factory/issues/939)
- [ADR-0048 — in-memory hosted job store](0048-hosted-job-store-is-an-in-memory-clock-injected-control-plane-store-with-fixed-idempotency-check-ordering.md)
