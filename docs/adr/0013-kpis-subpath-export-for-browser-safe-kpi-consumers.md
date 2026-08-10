# ADR-0013: A fourth subpath export, `./kpis`, for browser-safe KPI consumers

- Status: Accepted
- Date: 2026-08-10
- Amends: [ADR-0004](0004-narrow-public-core-api.md)

## Context

ADR-0004 narrowed `@on-par/factory-core`'s public surface to three entry points
(root, `./internal`, `./testing`). The KPI trend view (#616) needs to render real
`computeKpiDrift`/`parseKpiHistory`/`computeHealthKpis` output in the `dashboard`
package, which runs in a browser bundle. The root entry point (`.`) transitively
pulls in Node-only harness/router dependencies (`execa`, `@octokit/rest`) that don't
resolve in a browser build, so `dashboard` cannot import KPI functions from `.`
without also pulling in code that cannot exist client-side. The alternative —
hand-porting the KPI derivation logic into `dashboard` — was rejected: it is exactly
the kind of duplicated invariant ADR-0004 already exists to prevent, and it would
silently drift from the real implementation the moment either copy changed.

## Decision

Add `@on-par/factory-core/kpis`, a fourth subpath re-exporting the same KPI
functions already documented as part of the root public API (`computeKpiDrift`,
`parseKpiHistory`, `computeHealthKpis`, and the rest of the "KPIs" block) from a new
`kpis-entry.ts`. It adds no new public surface — every export here is already public
via `.` — the split exists only to make that existing surface reachable without the
Node-only baggage the root entry point carries. `packages/core/src/public-api.test.ts`
is extended to pin the runtime export set of all four entry points (was three), and
`package.json`'s `exports` map gains the new subpath.

Per this repo's ADR discipline (never rewrite an Accepted ADR's history), ADR-0004's
original text is left untouched; this ADR is the record of the amendment, linked from
both directions.

## Consequences

Positive: `dashboard` (and any future browser-side consumer) imports the real KPI
logic instead of maintaining a parallel copy, closing off a duplication path before
it starts. The public surface itself does not grow — nothing is exported from `./kpis`
that wasn't already exported from `.` — so ADR-0004's narrowness goal holds.

Negative: a fourth entry point is one more line in the `public-api.test.ts` allowlist
and one more subpath consumers need to know about. Future KPI functions added to the
root export must be deliberately mirrored into `kpis-entry.ts` (or the browser build
silently falls behind); nothing currently enforces that beyond code review and this
ADR's stated intent.

## References

- [ADR-0004 — A narrow public API for `@on-par/factory-core`](0004-narrow-public-core-api.md)
- [Issue #616 — KPI trend view](https://github.com/on-par/software-factory/issues/616)
