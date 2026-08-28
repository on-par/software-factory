# ADR-0051: Provider-session authority is a job-scoped bundle of opaque handles, resolved and mounted behind an injected broker, and fails closed

- Status: Accepted
- Date: 2026-08-26

## Context

Hosted-exec jobs need long-lived user provider credentials (Codex OAuth,
Claude Code OAuth, OpenCode Go OAuth, pi.dev) inside a disposable
container. These are more varied and more sensitive than the GitHub
authority slice (#901/#902) and must never become ambient runner state,
never be persisted raw in job records, and never be written to logs in
plaintext (issue #906 out-of-scope constraints). The hosted-exec family
already establishes that effectful boundaries sit behind injected ports
(ADR-0049 ContainerEngine) and that the persisted contract stays in
@on-par/contracts (ADR-0047). A boundary chosen here constrains every
future provider integration, so it is worth pinning.

## Decision

Provider session material is represented as a job-scoped
ProviderSessionBundle in @on-par/contracts: a closed provider-kind enum
plus one-or-more opaque secret refs (name + handle) — never raw values.
Core's withAuthority orchestrator resolves those refs to transient
ResolvedSecret values through an injected AuthorityBroker, materializes
them through an injected AuthorityMountEngine, hands the caller a redact
closure that masks every secret value out of logs, and always unmounts in
a finally. It fails closed before mounting whenever authority is absent,
invalid, unsupported by the runner, or unresolvable. Raw secrets never
appear in the persisted bundle, the job record, the outcome, or a log.

## Consequences

Positive: provider credentials stay off persisted state and out of logs by
construction; unsupported/absent authority can never silently start
provider-dependent work; the port shape lets a real docker/fs mount
adapter land later without touching the orchestrator. Negative: every
provider integration must route through the broker+mount ports and honour
redaction rather than reading ambient env/credentials directly; the enum
must be extended (a contract change) to support a new provider kind.

## References

- [ADR-0049 — hosted-exec container execution runs behind an injected ContainerEngine port](docs/adr/0049-hosted-exec-container-execution-runs-behind-an-injected-containerengine-port.md)
- [ADR-0047 — hosted execution flag + contract in @on-par/contracts](docs/adr/0047-hosted-execution-is-gated-behind-an-off-by-default-env-flag-and-its-contract-lives-in-on-par-contracts.md)
- [Issue #906](https://github.com/on-par/software-factory/issues/906)
