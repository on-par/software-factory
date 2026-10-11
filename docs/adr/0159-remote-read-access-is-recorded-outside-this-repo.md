# ADR-0159: Remote read access is recorded outside this repo

- Status: Moved
- Date: 2026-10-11

## Context

ADR-0159 recorded how a separate, out-of-repo client reads factory status remotely. That decision is about a
deployment that lives outside On PAR Dev's Software Factory, so its record now lives with that deployment.

## Decision

This number is kept as a stub so it is not reused. Nothing in this repo changes: factoryd's HTTP API stays
loopback-only, as [ADR-0034](0034-factoryd-s-http-api-is-authorized-by-its-loopback-binding-alone.md) says, and is
never tunneled or proxied.

## Consequences

- No code or configuration in this repo depends on this ADR.
- Any remote surface for factoryd still needs its own ADR with a real authentication design.
