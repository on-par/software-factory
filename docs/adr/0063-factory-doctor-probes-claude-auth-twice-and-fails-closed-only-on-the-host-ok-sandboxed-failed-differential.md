# ADR-0063: factory doctor probes Claude auth twice and fails closed only on the host-ok/sandboxed-failed differential

- Status: Accepted
- Date: 2026-08-29

## Context

Nothing in the factory could tell "Claude is not authenticated" apart from "Claude is
authenticated but the sandbox blocks its credential refresh". Both surface as
`local_auth`, and the router treats both as an ordinary provider failure and fails
over — so #1008 presented as six issues parked with no diff while a host probe of
`claude -p` returned `ok` on the same machine. A single auth check cannot separate
those two causes: only the difference between a host run and a sandboxed run
attributes the failure. Running the sandboxed probe alone is also not enough — if the
host itself is unauthenticated the sandboxed probe fails too, and blaming the sandbox
would send an operator to fix the wrong thing.

## Decision

`factory doctor` reports Claude auth as two separate checks, `claude auth (host)` and
`claude auth (sandboxed)`, from two real `claude -p` invocations: one bare, one
wrapped by `wrapCommandInSandbox` using the repo's own resolved sandbox policy. The
pure `sandboxClaudeAuthChecks()` in `packages/cli/src/cli/doctor.ts` maps the probe
pair to checks, and exactly one combination is a hard (non-optional) doctor failure:
host `ok` and sandboxed `failed`. A failing sandboxed probe with a host probe that is
itself failing or skipped is reported as an optional warning, never as a sandbox
fault. The sandboxed probe is skipped, not failed, when the host probe did not
succeed, when no sandbox runtime is available, or when the sandbox is disabled.
`wrapCommandInSandbox` is exported from `@on-par/factory-core/internal` (not the root
public API) so the CLI can build the wrapped command; per ADR-0004 it is an
implementation detail, not part of the stable surface.

## Consequences

Positive: the exact fault that stranded #1008 is detected before a run starts, and it
is attributed to the sandbox only when the evidence actually supports that; the
doctor's fix line can point at `FACTORY_SANDBOX=0` and at the write allowlist.
Negative: `factory doctor` is no longer offline or free — it makes up to two real
Claude API calls and needs a timeout well above the 10s the other doctor probes use,
so it is slower and costs tokens on every invocation. Future doctor work must keep
that cost in mind rather than assuming doctor is a cheap local preflight. The check
also depends on `claude -p` staying a valid one-shot invocation.

## References

- [Issue #1008 — factory doctor should fail closed on sandboxed Claude auth](https://github.com/on-par/software-factory/issues/1008)
- [ADR-0004 — A narrow public API for @on-par/factory-core](https://github.com/on-par/software-factory/blob/main/docs/adr/0004-narrow-public-core-api.md)
