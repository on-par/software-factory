# ADR-0019: The codex harness reads token usage from `codex exec --json`, trading away the stderr model banner

- Status: Accepted
- Date: 2026-08-12

## Context

Issue #425 requires the codex route to report real token counts on the same
`CostEntry` contract as the Claude route, so the PLAN phase's codex-vs-claude
routing decision can be evaluated on measured cost rather than on a
character-count heuristic.

Codex's human-readable output cannot supply that. Verified against codex-cli
0.144.6 with this harness's exact invocation: a completed run prints a single
blended `tokens used\n5,639` line on stderr, with no input/output split and no
cache breakdown. `CostEntry.inputTokens`/`outputTokens` cannot be filled from it
without inventing a split.

`codex exec --json` does supply it. The same invocation with `--json` added emits
JSONL on stdout ending with
`{"type":"turn.completed","usage":{"input_tokens":…,"cached_input_tokens":…,"output_tokens":…,"reasoning_output_tokens":…}}`,
and `--output-last-message` keeps working unchanged, so the harness's output
contract is untouched.

Two things move with it, both confirmed by probe. First, the human banner block
that carries `model: <served model>` disappears from stderr — that banner is the
sole input to the served-model assertion added by #415 to catch codex silently
serving a model other than the pinned one. Second, API failures stop printing to
stderr and appear instead as `{"type":"error",…}` / `{"type":"turn.failed",…}`
events on stdout; on a probe of a rejected model, stderr was empty apart from a
shell notice. `classifyFailure` reads stderr only, so `rate_limit` and `usage_cap`
would silently degrade to `unknown` and change how the router fails over.

## Decision

The codex harness invokes `codex exec --json` and derives `HarnessUsage` from the
`turn.completed` events on stdout, summing across them when a run reports more than
one. `input_tokens` is codex's total input-side count and already contains
`cached_input_tokens`, so it maps to `inputTokens` directly, `cached_input_tokens`
maps to `cacheReadTokens`, and the remainder maps to `rawInputTokens` — the same
field meanings the Claude harness fills. Fields codex does not report
(`cacheCreationTokens`, `numTurns`, `durationMs`, `durationApiMs`, `costUsd`) are
omitted rather than synthesized, so cost falls through to the registry's price
table exactly as it does for a Claude envelope without a cost figure. Parsing is
tolerant at every step: non-JSON lines, absent usage, and malformed counts all
resolve to "no usage", which the router already renders as `estimated: true`. Usage
capture never fails a run.

On the error path the harness classifies on stderr plus the text of `error`,
`turn.failed`, and error-typed `item.completed` events — those events only. The
agent transcript is deliberately excluded so that prose or command output
mentioning a limit cannot manufacture a `rate_limit` or `usage_cap` verdict.

The served-model assertion stays in place unchanged and is accepted as a no-op on
CLI versions that print no banner, which its own tolerance case already documents.
Restoring that verification under `--json` — from a future `model` field on the
event stream, or from the session rollout file — is follow-up work, not a
precondition for real cost rows.

## Consequences

Codex rows in `.factory/costs.jsonl` carry provider-reported counts with
`estimated: false`, on the same schema and through the same reader as Claude rows,
so route-level cost comparison needs no per-route special casing.

The #415 served-model guard no longer fires against codex 0.144.6. A silent model
substitution on the codex route would now go unnoticed until it showed up in output
quality or in the price-table cost of the wrong model. This is the accepted cost of
the change and the reason the assertion is kept rather than deleted: it resumes
working on any CLI version or wrapper that still prints the banner.

The CLI transcript now flows through stdout instead of stderr, under the same 10MB
`maxBuffer`. The harness is coupled to codex's JSONL event schema; a rename of
`turn.completed` or of the `usage` fields silently reverts codex rows to
`estimated: true` rather than breaking a run, so the estimated-row share is the
signal that the schema has moved.

## References

- [Issue #425 — Capture real token usage from the codex CLI harness](https://github.com/on-par/software-factory/issues/425)
- [Issue #424 — the Claude-harness sibling that defined the HarnessUsage contract](https://github.com/on-par/software-factory/issues/424)
- [Issue #415 — served-model verification from the codex stderr banner](https://github.com/on-par/software-factory/issues/415)
