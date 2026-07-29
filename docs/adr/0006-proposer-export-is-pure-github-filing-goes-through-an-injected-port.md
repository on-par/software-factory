# ADR-0006: Proposer export is pure; GitHub filing goes through an injected port

- Status: Accepted
- Date: 2026-07-29

## Context

The product app (`@on-par/product`) is the proposer: it turns a brain-dump into
engineering-ready artifacts and, by design, never writes a target checkout. Its
dependency set is deliberately lean (`@on-par/adr-kit`, `@on-par/contracts`,
`commander`), while concrete GitHub wiring (octokit clients, credentials) already
lives in `@on-par/factory-core` (`packages/core/src/filing`). The export step (#476)
is the first place the proposer must cause an external side effect — filing issues
on a target repo — and the package carries a 99% coverage bar, so the side effect
must be testable without a network.

## Decision

The export module keeps a strict pure/effect split. `planExport` and
`buildDesignBundle` are pure: they gate on the human handoff decision and produce an
`ExportPlan` whose `DesignBundle` is a list of in-memory `{path, content}` markdown
files — that list IS the markdown handoff; callers decide where (or whether) it
lands on disk. The only effectful function, `exportToGitHub`, talks exclusively to an
`ExportGitHubClient` port (createIssue/commentIssue, shaped after core's
`FilingGitHubClient`) that the caller injects. The product package itself takes no
octokit, fs, network, or clock dependency, and ADR drafts are serialized with status
Proposed only — the factory's ADR writer remains the sole writer of `docs/adr`.

## Consequences

Positive: the export is fully unit-testable with in-memory fakes at the package's
coverage bar; credential handling stays out of the proposer; the same `ExportPlan`
serves both the GitHub and markdown handoff targets. Negative: every future consumer
(CLI command, factory integration, server) must construct and inject a real
`ExportGitHubClient` adapter — e.g. over core's octokit wiring — and the port's shape
is intentionally duplicated from core's `FilingGitHubClient` rather than imported,
since product must not depend on core.

## References

- [Issue #476 — product app: Export](https://github.com/on-par/software-factory/issues/476)
