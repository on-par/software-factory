# ADR-0080: The workspace diff base is the run-start HEAD, captured once, authoritative for CHECK

- Status: Accepted
- Date: 2026-09-03

## Context

The choice of diff base in workspace (localOnly) mode is a semantic contract, not
an implementation detail: workerOutputChecker and designSmellsChecker both derive
their verdicts from collectDesignDiff, which is invoked once per CHECK round,
including every rework round within a single run. If each round resolved its base
independently, a base that drifted between rounds (e.g. re-reading HEAD after a
rework commit) would silently change what "the diff" means mid-run — work from an
earlier round could vanish from later diffs, or already-graded work could be
recounted — corrupting both the design-smells critique and SCBench's grading,
which depends on a stable, correctly-scoped diff. #1210 (PR #1230) fixed this by
capturing runStartDiffBase exactly once in runIssue, before PLAN runs, and
threading it unchanged into every checkPhase call for localOnly runs. Separately,
#1211/#1212 (PR #1216) wired workerOutputChecker and designSmellsChecker to accept
that captured base as collectDesignDiff's fallbackBaseRef, used only when neither
origin/main nor origin/master resolves — real worktrees with a remote base still
take precedence, since that is the actual merge target. Neither change was
recorded as an ADR, so the next person to touch collectDesignDiff, captureDiffBase,
or either checker has no written signal that "base" is a fixed contract they must
preserve rather than a detail they can reinterpret.

## Decision

The diff base for a workspace (localOnly) run is the worktree's HEAD SHA, captured
exactly once by captureDiffBase(ports.workspace.path) in runIssue before PLAN
executes. That single value (runStartDiffBase) is threaded unchanged as
CheckPhaseOpts.diffBase / CheckerContext.diffBase into every checkPhase invocation
for the run, including every rework round — no checker or diff collector re-derives
or refreshes it mid-run. collectDesignDiff resolves the actual base ref with fixed
precedence: it tries BASE_REF_CANDIDATES (`origin/main`, then `origin/master`) first,
and only falls back to the caller-supplied fallbackBaseRef (the captured run-start
HEAD for localOnly runs; buildPhase's pre-worker HEAD otherwise) when neither remote
candidate resolves in that worktree — a real worktree with a resolvable remote base
always outranks the captured SHA, because the remote base is the actual merge
target. When neither a remote candidate nor a valid fallback resolves,
collectDesignDiff returns a CollectedDiff with `skipReason` set and no diff text;
workerOutputChecker and designSmellsChecker both surface that as
`{ result: 'SKIP', details: skipReason }` — an unresolvable base is never treated as
"no changes" (PASS) nor as "changes exist" (FAIL), because neither claim has
evidence behind it. This base is authoritative for every diff-derived CHECK
artifact in the run (design-smells critique, worker-output verification), not only
for the first round.

## Consequences

Positive: every rework round in a localOnly run judges the same diff scope, so
design-smells findings and worker-output verification stay consistent across
rounds instead of drifting as the worktree accumulates rework commits; the
SKIP-on-unresolvable-base rule keeps an unverifiable diff from ever being
misreported as a clean pass, protecting SCBench grading and any other consumer
that treats a checker PASS as evidence; the remote-ref-first precedence keeps real
(non-localOnly) worktrees diffing against their actual merge target rather than an
arbitrary captured SHA. Negative: the captured base is now a piece of state that
must be threaded correctly through every future phase-boundary change (runIssue →
checkPhase → CheckerContext) — a refactor that drops or re-derives diffBase along
that path would silently reintroduce the moving-target bug this contract exists to
prevent, so any such change should be checked against this ADR rather than assumed
safe from the code alone.

## References

- [Issue #1214: ADR: define the diff base for workspace runs](https://github.com/patrob/software-factory/issues/1214)
- [Issue #1210 / PR #1230: capture run-start HEAD once in runIssue for localOnly diffBase](https://github.com/patrob/software-factory/pull/1230)
- [Issue #1212 / PR #1216: designSmellsChecker critiques the workspace diff via the captured run-start base](https://github.com/patrob/software-factory/pull/1216)
- [ADR-0071 SCBench rework is a bounded adapter re-invocation of run-brief, not a core pipeline hook](0071-scbench-rework-is-a-bounded-adapter-re-invocation-of-run-brief-not-a-core-pipeline-hook.md)
- [Issue #1214](https://github.com/on-par/software-factory/issues/1214)
