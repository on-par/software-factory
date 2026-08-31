# ADR-0068: docker-sandbox lanes bypass the host port-lease and reverse proxy

- Status: Accepted
- Date: 2026-08-31

## Context

The host port-lease registry (`.factory/ports.json`) and the loopback reverse proxy exist only
because ordinary lanes share one host network and must not collide on ports. A docker-sandbox lane
runs inside a microVM with its own network namespace, so it can bind its normal default port with
no host-level allocation and needs no stable proxy URL keyed off a lease. Keeping such a lane on
the shared-host bookkeeping would allocate a host port it never binds and publish a proxy route
that points nowhere.

## Decision

A lane resolved to the docker-sandbox runtime skips the host port-lease entirely:
`resolveEnvironmentAcquirer` returns no acquirer for it, so `acquirePortLease` is never called and
no lease is written. Because the proxy derives every route from the lease registry, absence of a
lease is by construction absence of a proxy route. The lane binds its normal port inside its own
microVM, and the microVM's egress is governed by the sandbox config's allowlist rendered into
`sbx create` at VM-creation time. This exemption applies only to docker-sandbox; every other
runtime keeps the existing port-lease/proxy path unchanged.

## Consequences

Positive: no wasted host-port allocation or dead proxy routes for microVM lanes; per-lane egress
filtering becomes expressible (which the host runtimes cannot do). Negative: docker-sandbox lanes
are invisible to host-side port bookkeeping, so any future feature built on the lease registry or
proxy (dashboards, health reports, port-conflict reaping) must treat docker-sandbox lanes as
legitimately absent rather than missing. The in-VM port is not reachable from the host via the
proxy; a later story owns any host↔VM addressing if that is needed.

## References

- Issue #654: https://github.com/on-par/software-factory/issues/654
