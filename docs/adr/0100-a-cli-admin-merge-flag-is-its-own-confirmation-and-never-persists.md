# ADR-0100: A CLI admin-merge flag is its own confirmation and never persists

- Status: Accepted
- Date: 2026-09-12

## Context

ADR-0098 requires a distinct confirmation token (`ENABLE_ADMIN_MERGE_BYPASS`) before the loopback settings API writes `run.merge.admin: true` into `.factory/config.json`, because that write is persistent, is made from a browser UI several clicks removed from the consequence, and silently changes the merge behavior of every later run. Issue #1402 adds `--admin-merge` / `--no-admin-merge` to `factory run` and `factory supervise`, which raises the question whether the CLI must demand the same ceremony. Without a recorded answer the asymmetry looks like an oversight, and a future change could either bolt a token prompt onto the CLI or drop the token from the settings API "for consistency." AGENTS.md's merge policy also makes the stakes explicit: admin merges exist for narrow, deliberate cases and must never be how a genuinely failing check gets past the gate.

## Decision

The CLI flag carries no confirmation token. Typing `--admin-merge` on an invocation is the deliberate act ADR-0098's token stands in for: it is a human keystroke at the point of action, it scopes to a single `factory run` (or the cycles one `factory supervise` drives), and it writes nothing to `.factory/config.json`. The flag is recorded only in `.factory/state/run-flags.json`, purely so a separate `factory status` process can attribute the policy, and a later flagless run deletes that file. An explicit flag outranks `run.merge.admin` and `FACTORY_MERGE_ADMIN` and is reported as `sources.admin === 'flag'`.

The flag selects only the `admin` argument of the existing merge call. The `watchCi()` gate in `landOpenPullRequest` is untouched, so `--admin-merge` still cannot merge a PR whose CI has not reported a real success.

## Consequences

Positive: the operator-facing path stays a single command with no token dance; admin-merge behavior becomes visible and attributable in `factory status` instead of being inferred from machine-local environment; the blast radius of a mistaken flag is one invocation rather than a persistent config change; and the ADR-0098 gate keeps its narrow, defensible scope for persistent writes from the app.

Negative: two admin-merge entry points now have visibly different ceremony, which must be explained rather than discovered; a shell alias or script could embed `--admin-merge` and make it effectively persistent for whoever uses that alias, with no config file to audit; and `.factory/state/run-flags.json` becomes one more piece of state that must stay truthful about the current run.

References:

- ADR-0098 — enabling admin-merge requires a distinct confirmation token
- Issue #1402
