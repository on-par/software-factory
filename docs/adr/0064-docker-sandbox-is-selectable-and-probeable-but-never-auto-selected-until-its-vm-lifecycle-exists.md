# ADR-0064: docker-sandbox is selectable and probeable, but never auto-selected until its VM lifecycle exists

- Status: Accepted
- Date: 2026-08-29

## Context

Docker Sandboxes (`sbx`) is being adopted as a microVM-per-agent runtime to replace
OS-level `sandbox-exec`/`firejail` wrapping (epic #651). Unlike those two, it is not a
command prefix: it needs VM create/mount/teardown, which lands separately in #653.
Issue #652 adds only the selection surface, and it carries two requirements that pull
against each other: `detectSandboxRuntime()` must check for the `sbx` binary, and
`auto` must resolve to exactly today's runtime on every host with no behavior change
for any existing lane. A plain preference-ordered probe cannot satisfy both — a
developer host that already has `sbx` installed would flip to a runtime whose wrapping
is a no-op, silently dropping containment for real BUILD runs. The blast radius is
every agentic lane, and the failure mode is invisible: an uncontained agent that logs
as sandboxed.

## Decision

The `sbx` probe lives inside `detectSandboxRuntime()` but is gated by an explicit
opt-in third argument, `{ includeDockerSandbox }`, defaulting to false. The `auto`
branch of `resolveSandboxRuntime()` calls it without that flag, so `auto` can never
resolve to `docker-sandbox` until a later story deliberately flips the flag. Selecting
`docker-sandbox` is therefore an explicit act — `sandbox.runtime: "docker-sandbox"` in
`.factory/config.json`, or `FACTORY_SANDBOX_RUNTIME=docker-sandbox` for one run — and
an explicit selection is honored verbatim without any host probe, so the runtime is
never silently downgraded to something the operator did not ask for. Until #653 lands
a real lifecycle, `wrapCommandInSandbox` treats `docker-sandbox` exactly like `none`
(returns the command unchanged) and the CLI logs a `sandbox-unavailable` event naming
#653, so a lane that opts in is reported as uncontained rather than as contained.

## Consequences

Positive: `auto` — the shipped default and what every existing lane uses — is provably
unchanged, so this story cannot regress containment. The new runtime is reachable for
#653/#655 development and A/B work today, and an operator who opts in early is told
plainly that the lane is uncontained instead of being misled. Explicit-beats-probe
also means a missing `sbx` binary surfaces as a visible failure rather than as a quiet
fallback to a different runtime.
Negative: `includeDockerSandbox` is a flag with no production caller until a later
story turns auto-selection on, which reads as dead weight from the code alone (this
ADR is the reason it exists). The invariant is a convention, not a type: a future
change could pass the flag from the auto path and break the no-default-change
guarantee, so the unit test asserting that `auto` with `sbx` present still resolves to
the legacy runtime is load-bearing and must not be deleted. The `docker-sandbox`
no-wrap behavior is deliberately temporary and must be replaced — not extended — when
#653 lands the VM lifecycle.

## References

- [Epic](https://github.com/on-par/software-factory/issues/651)
- [Issue](https://github.com/on-par/software-factory/issues/652)
- [Issue](https://github.com/on-par/software-factory/issues/653)
