# ADR-0003: Quarantine the Ollama command-agent spike behind the experimental flag

- Status: Accepted
- Date: 2026-07-17

## Context

`codex-ollama-qwen3.5:9b` was added as a spike to let local-only runs serve
`build_codex` with a free Ollama model. A Claude Opus review of the branch
flagged its `codexFlag: "--oss --local-provider ollama -m qwen3.5:9b"` as dead
config: `codexFlag` is consumed only by the `codex-cli` harness
(`packages/core/src/harness/codex-cli.ts`), but this model declares
`harness: "ollama-agentic"`, and even the legacy inference for
`provider: ollama` + `codex: true` (`ModelRegistry.getHarnessId`,
`packages/core/src/models/index.ts`) dispatches to the native
`ollama-command-agent` loop — `codex exec --local-provider` is never invoked.
Meanwhile `docs/research/small-model-factory-harness.md` concluded the
durable design for small local models is a stepwise patch harness (issues
#170/#171, epic #163), not a command-agent loop, and the first local-only
comparison run failed in BUILD. Left unmarked, the spike reads like the
intended architecture and its position at the head of the worker tier makes
it the default local-only `build_codex` route.

## Decision

Mark the model `experimental: true` so it is excluded from routing unless
`FACTORY_EXPERIMENTAL=1` (the pre-existing quarantine mechanism); delete the
dead `codexFlag`; keep `codex: true` solely as the `build_codex`
routing-eligibility marker; keep the model listed in the worker tier so
opting in requires only the env var.

**Retire/keep condition:** after #170 lands its bounded retry test and the
stepwise patch harness produces its first green fixture run, either retire
this model entry (and the `ollama-command-agent` legacy inference/dispatch
path with it) or keep it as a permanent experimental alternative — decided in
a follow-up issue on epic #163; it does not graduate out of `experimental`
without that decision.

## Consequences

Positive:

- Default local-only runs no longer pick the spike for `build_codex` (the
  chain falls through to the other local workers or the route escalates).
- Contributors can no longer copy a dead `codexFlag` pattern.
- The schema keeps `codexFlag` optional for real codex-cli models
  (`gpt-5.6-sol`, `gpt-5.1-codex`).
- Tests pin the quarantine so un-marking it is a deliberate act.

Negative / accepted trade-offs:

- The spike is not removed outright, so the `ollama-command-agent` legacy
  dispatch path stays in the codebase until the retire/keep decision is made.
