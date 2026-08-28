# ADR-0059: A detach drains through a `draining` registry state, and lane status arrives via an injected port

- Status: Accepted
- Date: 2026-08-19

## Context

factoryd's repo registry (~/.factory/registry.json) had three states: `active`, `paused`,
and the `detached` tombstone. Detaching a repo has to do two things that cannot happen at
the same instant: stop claiming new issues _now_, and stop the engine only _after_ any
in-flight lane has reached a safe RunStatus boundary. The registry file is the only
durable, cross-process record of what the daemon may dispatch to, so "stopped claiming but
not yet detached" has to be representable there — an in-memory flag would not survive a
restart and would not be observable to an operator running GET /repos.

Reusing `paused` was the obvious shortcut and was rejected: it reports a state the operator
never asked for, and POST /repos/<slug>/resume would silently cancel an in-flight detach.

Separately, this checkout has no lane-status persistence at all. `IssueRunState` is a type
in packages/core/src/types/index.ts with no reader, and daemon process lifecycle is
explicitly out of scope for epic #761's story 3. The drain therefore needs a source of lane
status that does not yet exist.

## Decision

Add `draining` as a third live `RepoState`. A detach is two phases: `beginDetach` writes
`draining` synchronously (or `detached` directly under `?force=true`), and `drainAndDetach`
writes the `detached` tombstone only after the drain clears. `dispatchableRepos` keeps its
existing `state === 'active'` filter, so a `draining` repo is ineligible for new claims from
the instant the DELETE response is written, with no change to the dispatch gate itself.
`setRepoState` rejects a `draining` entry with reason `draining` exactly as it already
rejects a `detached` one, so pause/resume can never cancel a detach.

A lane is blocking while its `RunStatus` is one of `planning`, `building`, `checking`,
`reworking`, or `shipping`; every other status — including `pending`, `ready`,
`awaiting-review`, `parked`, `escalated`, `merged`, and `failed` — is a safe boundary. The
set is defined by what is _unsafe to interrupt_, not by what is terminal, so a queued or
already-finished lane never stalls a drain.

Lane status enters the drain through an injected `readLaneStatuses(repoPath)` port on
`DetachRepoDeps`. Until the daemon engine story lands, the default reader reports no lanes,
so an unwired factoryd drains immediately; the engine supplies the real reader when it
exists. Neither phase reads or writes the repo checkout's own `.factory/` directory.

A drain that exceeds `drainTimeoutMs`, or one aborted by `FactorydServer.stop()`, leaves the
entry in `draining` and writes no tombstone. `?force=true` on a `draining` entry is the
documented escape, and its contract is that worktrees may be orphaned.

## Consequences

Positive: "stopped claiming, still finishing" is a first-class, durable, operator-visible
state that survives a daemon restart; the dispatch gate needed no change; force-detach is a
single, clearly bounded unsafe operation instead of the default behaviour.

Negative: `RepoState` is now a four-member union, so every consumer must handle `draining`
— most importantly `loadRegistry`'s `REPO_STATES` validator, which would otherwise drop a
draining entry as malformed and resurrect the repo into dispatch. A drain can be left
hanging in `draining` forever if the injected reader never reports a safe boundary; the
timeout bounds the poll loop but deliberately does not force the tombstone, so an operator
must decide. And until the engine story wires a real `readLaneStatuses`, the default drain
is a no-op that detaches immediately — correct for a daemon with no engine attached, but it
means this story's drain guarantee is only as strong as the reader later injected into it.

## References

- [Issue](https://github.com/on-par/software-factory/issues/780)
- [ADR-0036 — pause and resume act only on live registry entries](https://github.com/on-par/software-factory/blob/main/docs/adr/0036-pause-and-resume-act-only-on-live-registry-entries-a-detached-tombstone-is-never-revived.md)
- [ADR-0034 — factoryd's HTTP API is authorized by its loopback binding alone](https://github.com/on-par/software-factory/blob/main/docs/adr/0034-factoryd-s-http-api-is-authorized-by-its-loopback-binding-alone.md)
