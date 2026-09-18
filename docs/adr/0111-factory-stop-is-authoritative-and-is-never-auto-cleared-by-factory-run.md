# ADR-0111: `.factory/STOP` is authoritative and is never auto-cleared by `factory run`

- Status: Accepted
- Date: 2026-09-18

## Context

#811 made `factory run` auto-delete a pre-existing `.factory/STOP` at
startup, reasoning that invoking `factory run` is always a fresh, explicit
intent to proceed. That assumption held when `factory run` was invoked once
by a human or a cron tick, but broke once several repos moved to launchd
`KeepAlive` supervisors that re-invoke `factory run` in a tight `while true`
shell loop: the loop's very next spawn after STOP is set deletes the file and
resumes claiming work, making STOP (and lifting it) cosmetic for those repos.
The retro (2026-09-17) identified this as a root cause of a factory
continuing to run for days after it was believed stopped. Some mechanism
independent of the supervisor was needed, and `.factory/STOP` — a plain file
any supervisor's next loop pass can observe — is the only signal common to
cron, launchd, and a bare nohup loop alike.

## Decision

`factory run` checks `.factory/STOP` at the very top of every invocation,
before planning or claiming any work, and never deletes or modifies it. When
present, the run logs a `stopped` event and a console warning and exits
cleanly having started no lanes. The file is cleared only by an explicit
human/automation action — `factory resume` or removing it directly — never by
`factory run` itself. `runLane`'s existing mid-run per-issue check (unchanged)
still drains a run gracefully if STOP appears after lanes have already
started.

## Consequences

Positive: STOP is now a single, supervisor-independent halt switch — a
`while true; do factory run; done` loop, cron, or a bare nohup process all
stop claiming new work within one loop iteration of STOP appearing, and
resume within one iteration of it being removed, with no process restart.

Negative: a human who manually re-runs `factory run` right after setting STOP
for some unrelated reason (not to actually halt) will find the run silently
skips until they explicitly clear the file — this reverses #811's "fresh
invocation clears stale STOP" convenience in favor of correctness across
supervisors; the console/event message and `factory doctor`/`status` rows
make the paused state loud enough that this should not be mistaken for a
stall.

## References

- Issue #1517: run: honor a `.factory/STOP` sentinel at the top of every loop
  iteration
  https://github.com/on-par/software-factory/issues/1517
- #811 (original auto-clear behavior this reverses)
  https://github.com/on-par/software-factory/pull/811
