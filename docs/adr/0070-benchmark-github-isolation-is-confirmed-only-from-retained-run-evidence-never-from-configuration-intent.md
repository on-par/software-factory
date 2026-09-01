# ADR-0070: Benchmark GitHub isolation is confirmed only from retained run evidence, never from configuration intent

- Status: Accepted
- Date: 2026-09-01

## Context

The SlopCodeBench baseline (#1018/#1067) must prove that `factory run-brief
--workspace` runs created no GitHub issue, pull request, or merge, and that
local models were excluded. The workspace run path is structurally
publishing-disabled (`runIssue` returns before SHIP and emits
`local-only-complete`), and the workspace's `.factory/config.json` pins
`providers.ollama: false` — but configuration and code paths describe intent,
not what a specific recorded run actually did. ADR-0007 already established
for correctness that only retained native evidence counts; a baseline that
claimed isolation from intent alone could silently mask a misconfigured or
tampered run. The evidence available per trial is the retained manifest
(`run.profile`, `phases.ship`, run window) and the retained `events.ndjson`.

## Decision

The baseline report's GitHub-isolation verdict derives exclusively from
retained per-trial evidence, fail-closed. A trial counts as isolated only when
its manifest records `run.profile === 'local-only'` and `phases.ship ===
'skipped'`, and its retained `events.ndjson` parses, contains a
`local-only-complete` event, and contains no event whose type is in the pinned
publishing-path vocabulary `GITHUB_WRITE_EVENT_KINDS` (`ship`, `await-merge`,
`awaiting-review`, `landed`, `merged`, `human-merged` — kinds the factory
emits only on the GitHub-publishing path; deliberately excluding
`decompose_filed`, which local-only runs emit for a local queue rewrite). Any
observed write kind, foreign profile, or non-skipped SHIP renders the whole
baseline NOT CONFIRMED; absent or unparsable evidence renders it "not
confirmable"; "confirmed" requires every trial to carry positive evidence. The
report additionally prints each trial's run window so operators can
cross-check external GitHub audit logs, but the verdict never depends on such
a query — the generator stays pure over config + retained artifacts.

## Consequences

Positive: isolation claims are reproducible from the committed trial
directories alone; a run recorded before this evidence existed (e.g. the July
stub trials with empty events files) honestly reports "not confirmable"
instead of a hollow pass; tampering that re-enables publishing surfaces as NOT
CONFIRMED in the regenerated report, which is byte-pinned by tests. Negative:
the event-kind vocabulary is duplicated as strings in the adapter and must be
revisited if the factory ever renames its publishing-path event kinds or adds
a new GitHub-mutating kind — an addition the closed `EventKind` union in
`packages/core/src/events/kinds.ts` makes visible at review time but which
this adapter cannot detect automatically.

## References

- [Issue #1067](https://github.com/on-par/software-factory/issues/1067)
- [ADR-0007 — baseline correctness derives only from retained native SCBench evidence](0007-slopcodebench-baseline-correctness-derives-only-from-retained-native-scbench-evidence.md)
- [ADR-0069 — baseline provider policy is pinned as literal data and confirmed only from recorded model attempts](0069-baseline-provider-policy-is-pinned-as-literal-data-and-confirmed-only-from-recorded-model-attempts.md)
