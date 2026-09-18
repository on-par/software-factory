# Runbook: `.factory/STOP` sentinel

`.factory/STOP` is the one supported way to halt a running factory, no matter
what supervises its loop — cron, launchd `KeepAlive`, a bare `while true`
shell wrapper, or a plain nohup'd process. `factory run` checks the file at
the top of every invocation, before planning or claiming any work, and never
deletes or modifies it (#1517). That makes the file itself authoritative
across process boundaries: a `while true; do factory run; done` loop sees
STOP take effect on its very next spawn, and sees it lifted on the next spawn
after the file is removed — no supervisor restart required.

This reverses #811's prior behavior, where a fresh `factory run` invocation
auto-cleared any pre-existing STOP file on the theory that invoking `factory
run` was always a deliberate, fresh intent to proceed. That assumption broke
once several repos moved to launchd supervisors that re-invoke `factory run`
in a tight loop: the loop's very next spawn after STOP was set simply deleted
it and resumed claiming work, making STOP cosmetic. See
[ADR: `.factory/STOP` is authoritative and is never auto-cleared by `factory
run`](../adr/) for the full rationale.

## How to pause

`factory stop` (writes `.factory/STOP`), or `touch .factory/STOP` directly.

## How to resume

`factory resume` (removes it), or `rm .factory/STOP` directly. The next loop
iteration — the next `factory run` spawn, or the next issue boundary inside an
already-running lane — picks it up with no process restart needed.

## What does _not_ change

This does not pause or reconfigure any particular supervisor (cron, launchd,
systemd, a bare nohup loop). It only makes the file itself authoritative
regardless of which one is driving the loop; no supervisor wrapper script or
launchd plist needs to change.

`runLane`'s existing mid-run per-issue STOP check is unchanged: a STOP written
while lanes are already running still drains gracefully at the next issue
boundary, it does not abort mid-issue.

## Where the signal surfaces

- **`factory run`** — when STOP is present at startup, logs a `stopped` event
  (issue `'all'`) and a console warning naming the file's age, starts no
  lanes, and exits cleanly (not an error exit) without touching the file.
- **`factory status`** — prints a `!! STOP file present...` line.
- **`factory doctor`** — an explicit, non-failing (`optional`) "STOP sentinel"
  row naming whether `.factory/STOP` is present, mirroring how the
  auto-merge-sweep heartbeat check surfaces its signal (see
  [sweep-heartbeat.md](./sweep-heartbeat.md)).

## If a run is unexpectedly skipping

Run `factory doctor` or `factory status` and look for the STOP sentinel row —
if `.factory/STOP` is present, that's why. A human who manually re-runs
`factory run` right after setting STOP for some unrelated reason will find the
run silently skips until they explicitly clear the file with `factory resume`
or `rm .factory/STOP`.
