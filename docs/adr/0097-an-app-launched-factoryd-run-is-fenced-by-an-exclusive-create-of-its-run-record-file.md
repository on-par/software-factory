# ADR-0097: An app-launched factoryd run is fenced by an exclusive create of its run-record file

Status: Accepted

Date: 2026-09-12

## Context

App-launched self-fix and retry runs must survive a disconnected browser and must execute once
when a caller retries the same run id. A process-local idempotency map is lost when launchd
restarts factoryd. The registry's tmp-and-rename write is last-writer-wins, so it cannot make a
first-submitter claim. ADR-0009's fenced stale-lock steal is deliberately the opposite policy:
a run id must never be taken over after it has been claimed.

## Decision

The run identity is `<runsDir>/<runId>.json`. A safe run id is required before building that
path. `writeFile(..., { flag: 'wx' })` on the final path is the sole first-writer-wins claim;
there is no grace period, steal, or in-memory substitute. Existing records replay before a
registry lookup. After the claim, state transitions use atomic tmp-and-rename updates.

factoryd launches only the winning submission in a server-scoped pending set and awaits that set
during shutdown. The HTTP request does not own the execution. Crash recovery for a queued or
running record remains #1366 work and does not permit a second claim.

## Consequences

Duplicate and concurrent submissions persistently de-duplicate and GET can return the durable
record after reconnecting. Run ids are filesystem-safe rather than arbitrary opaque strings, and
records require a later retention policy. A corrupt claimed record remains unclaimable until a
human intervenes; this is safer than silently re-running work.
