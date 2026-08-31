# ADR-0066: Engines read a single-poller cached subscription-usage snapshot, never poll OAuth /usage directly

- Status: Accepted
- Date: 2026-08-30

## Context

factoryd runs multiple engines against one account-level 5-hour Claude usage window. Each engine
calling `fetchSubscriptionUsage` independently produces duplicate OAuth `/usage` calls and divergent
views of the shared headroom that admission control (epic #763) must arbitrate. The account window
is a single shared resource, so its observation must be single-sourced and consistent, and it must
survive a daemon restart without a cold-start blind spot.

## Decision

A single `UsageCoordinator` in `packages/core` owns the only poll loop that calls `fetchSubscriptionUsage`.
It caches the resulting `SubscriptionUsage` snapshot and persists it atomically to
`~/.factory/usage/coordinator.json` (tolerant load / tmp-file+rename write, mirroring
`daemon/registry.ts`). Engines obtain the current snapshot through the coordinator's synchronous
`read()`, never by calling `fetchSubscriptionUsage` themselves. `fetchImpl` and clock are injected via
the existing `SubscriptionUsageDeps` seams for deterministic tests. It is exported from
`@on-par/factory-core/internal`, consistent with other daemon-internal machinery under ADR-0004.

## Consequences

Positive: one OAuth `/usage` call per poll interval regardless of engine count; a single consistent
headroom view; a warm snapshot immediately after daemon restart. Negative: reads can be up to one
poll interval stale, and this establishes a contract that future engine and admission-control code
must honor (read the coordinator, do not fetch) — a constraint that is expensive to unwind once
engines depend on it.

## References

- Issue: https://github.com/on-par/software-factory/issues/1029
- Parent epic: https://github.com/on-par/software-factory/issues/763
