# ADR-0048: Hosted job store is an in-memory, clock-injected control-plane store with fixed idempotency check-ordering

- Status: Accepted
- Date: 2026-08-26

## Context

Story #897 (parent #895) must make the hosted-exec control plane durable and safe before
any runner or Docker work exists. The #896 contract defined the vocabulary as a pure typed
seam in @on-par/contracts; #897 needs the first stateful store and must encode idempotency
invariants that later runner/authority stories will build on: one active lease per job,
completion only by the active lease holder, duplicate terminal updates are harmless, and an
expired lease cannot mutate final state. Two invariants can collide (an expired holder
re-completing an already-terminal job), so their precedence must be fixed now, not left to
each future call site. The INVEST notes call the storage backend negotiable for the MVP and
say durability semantics matter more than final infrastructure.

## Decision

Own the hosted job store in packages/core (the engine), not in contracts (the pure typed
seam). Implement it as an in-memory Map keyed by jobId behind createHostedJobStore(), with
an injected epoch-ms clock so every timestamp and lease-expiry decision is deterministic and
testable. Lease validity is defined as "leaseId matches the current lease AND now <
expiresAt". Mutations follow one fixed check-ordering: job-not-found first; then an
already-terminal job is a harmless, audited no-op (this precedence means a duplicate or stale
terminal update never errors); then lease-mismatch; then lease-expired; then apply. Terminal
state is written exactly once and is immutable thereafter. acquireLease treats an expired
current lease as free and refuses terminal jobs. Mutations return discriminated result unions
rather than throwing. The in-memory backend is an implementation detail behind the
HostedJobStore interface; a persistent backend may replace it later without changing callers.

## Consequences

Positive: deterministic, fully unit-testable invariants with no Docker/fs/network; the store
sits beside core's existing control-plane registries (environment leases, queue); callers get
explicit outcomes instead of exceptions; a future durable backend is a drop-in.
Negative: the "terminal wins over expired-lease" precedence means a stale/expired holder that
re-submits the same terminal outcome gets a harmless success rather than a lease-expired
rejection — the state is still never mutated, but the audit event, not the return code, is
where that staleness is recorded. The in-memory store is not crash-durable yet, so
"durability" here is a logical guarantee (immutable terminal state, single active lease), not
persistence across process restarts.

## References

- [Issue](https://github.com/on-par/software-factory/issues/897)
- [ADR-0004 — narrow public core API](docs/adr/0004-narrow-public-core-api.md)
