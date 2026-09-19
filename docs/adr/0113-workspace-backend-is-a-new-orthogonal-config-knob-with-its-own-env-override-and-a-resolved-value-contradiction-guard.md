# ADR-0113: workspace.backend is a new orthogonal config knob with its own env override and a resolved-value contradiction guard

- Status: Accepted
- Date: 2026-09-19

## Context

Operators on Mini/VPS environments need to opt into disposable-container workspace
isolation without changing `sandbox.runtime` (process containment) or its defaults.
Before this change, Docker-related behavior lived entirely under `sandbox.runtime`, so
there was no way to express "workspace lives in a disposable container" independently of
"the BUILD agent's process containment boundary is a Docker sandbox" — and no guard against
an operator accidentally configuring both to point at conflicting Docker boundaries.
Separately, ADR-0102 (2026-09-14) retired several `FACTORY_*` environment overrides for
failover policy and stated that new policy settings should not introduce environment
overrides, migrating that class of setting to validated configuration instead. ADR-0102's
own scope note limits that rule to failover policy and leaves other existing
environment-based decisions (e.g. `FACTORY_SANDBOX_RUNTIME`) unchanged. Issue #1525
explicitly requires a `FACTORY_WORKSPACE_BACKEND` override, mirroring the pre-existing
`sandbox.runtime`/`FACTORY_SANDBOX_RUNTIME` shape rather than the newly-restricted
failover-policy shape.

## Decision

`workspace.backend` (`'worktree'` default | `'disposable-docker'`) is added as a new
top-level config section, a sibling of `sandbox`, not nested under it — the two are
orthogonal: `sandbox.runtime` governs process containment, `workspace.backend` governs
where the checkout/workspace lives. `FACTORY_WORKSPACE_BACKEND` is added as an explicit,
scoped exception to ADR-0102's "no new environment overrides" guidance, justified because
it follows the established `FACTORY_SANDBOX_RUNTIME` precedent that ADR-0102 itself left
untouched, and because the issue's acceptance criteria require it. The two knobs' resolved
(env-aware) values are validated together at CLI run-start (`cmdRun` and `shipIssue`, both
before any worktree/lane/container work) via `workspaceSandboxConflict`, which rejects
exactly the pairing `workspace.backend: disposable-docker` + `sandbox.runtime:
docker-sandbox` by exiting non-zero (`CliExitError`, code 2). The check compares resolved
*settings* (env override or literal config value), not a host-auto-probed runtime, so
`sandbox.runtime: auto` never trips this guard even on a host where auto-probing would
select `docker-sandbox`.

## Consequences

Positive: operators get an explicit, independently-overridable workspace-location knob
without perturbing `sandbox.runtime` defaults or behavior, and a fast, pre-flight guard
against a contradictory double-Docker-boundary configuration that would otherwise fail
confusingly (or silently) deep inside worktree/container setup. Negative: this establishes
a second `FACTORY_*` environment override in a codebase that is otherwise moving policy
settings away from environment variables (ADR-0102); any future `workspace.*` policy
addition should default to config-only unless it has the same "mirrors a pre-existing
env-driven sibling knob" justification `workspace.backend` has here. The contradiction
check is deliberately narrow (only the one literal pairing, only pre-probe settings) — a
future `sandbox.runtime: auto` that probes to `docker-sandbox` at the same time
`workspace.backend: disposable-docker` is configured is not caught by this guard and would
need a follow-up if that combination also needs blocking.

## References

- [Issue #1525: PLAN/config: workspace.backend (worktree|disposable-docker), orthogonal to sandbox.runtime](https://github.com/on-par/software-factory/issues/1525)
- [ADR-0102: Failover policy is owned by validated configuration](docs/adr/0102-failover-policy-is-owned-by-validated-configuration.md)
