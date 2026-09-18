# Runbook: auto-merge-sweep heartbeat

`scripts/auto-merge-sweep.sh` runs as a long-lived loop (typically under launchd)
landing green PRs across a configured set of repos. At the end of every completed
pass it writes an ISO8601 timestamp to a heartbeat file — the only externally
observable sign the loop is still alive. Nothing read that file until this
runbook's feature (#1516): when the sweep died on 2026-09-03 it stayed dead for
15 days before a human noticed.

## What writes the file

`scripts/auto-merge-sweep.sh`'s `write_heartbeat`, once per completed pass,
default every `SLEEP_SECONDS` = 300s. The path defaults to
`~/.factory/auto-merge-sweep.heartbeat` and is overridable with the
`HEARTBEAT_FILE` env var the sweep script itself reads.

## How to point a repo at it

Either:

- Set `sweep.heartbeatFile` in that repo's `.factory/config.json`, or
- Export `HEARTBEAT_FILE` in the environment `factory doctor`/`status` run in.

Config wins if both are set. Leaving both unset means "this repo doesn't run a
sweep" — `factory doctor`/`status` stay silent on the signal, matching the
default in `packages/config/src/defaults.ts`.

## Staleness formula

```
thresholdSeconds = loopIntervalSeconds * staleThresholdMultiplier
```

Defaults: `loopIntervalSeconds` = 300, `staleThresholdMultiplier` = 2, so the
default threshold is 600s (10 minutes) — twice the sweep's own loop interval.
Both are configurable per repo under `sweep.*` in `.factory/config.json`.

## Where the signal surfaces

- **`factory doctor`** — pushes a failing "auto-merge sweep heartbeat" check when
  a heartbeat file is configured and either missing or older than the threshold.
  Silent (no check at all) when no heartbeat file is configured by either config
  or env var.
- **`factory status`** — always prints a "Sweep heartbeat:" line under
  `== Health ==`, including an explicit "not configured" line, so the absence of
  a sweep is visible too.

## If it fires

Check the sweep loop / launchd job (`scripts/launchd/com.on-par.auto-merge-sweep.plist`)
is running and restart it. A missing file (never written) usually means a
misconfigured `HEARTBEAT_FILE` / `sweep.heartbeatFile` path or a sweep that never
started.
