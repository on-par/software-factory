# Runbook: factoryd

factoryd is the single long-running, **user-scoped** factory daemon: a
loopback-only HTTP API over the repo registry (`~/.factory/registry.json`,
epic #761). It is one process per user with many repos attached to it —
distinct from the per-repo `factory run` / `factory supervise` processes (and
the per-repo LaunchAgent supervisors already on the Mini), whose state lives in
each checkout's `.factory/` directory.

## Starting it

```bash
factory daemon run [--port N] [--registry FILE]
```

Runs in the foreground and binds `127.0.0.1` only (binding to loopback is the
authorization model — ADR-0034). `--port` defaults to 8787; `--registry`
defaults to `~/.factory/registry.json` and is the single knob that relocates
**all** daemon state.

## Runtime state files

All live in `dirname(registry)` — `~/.factory/` by default (#1177, ADR-0076):

| File          | Contents                                                                                                                          |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `daemon.pid`  | The daemon's pid — the single-instance guard. A second `daemon run` fails fast with exit code 2 naming the holder pid.            |
| `daemon.port` | JSON `{ pid, port, host }` with the **actually bound** port — read this to find the listener (e.g. when started with `--port 0`). |
| `daemon.log`  | A timestamped copy of every daemon log line (startup banner, one line per handled request), appended for the life of the process. |

## Restart semantics

- **Clean shutdown** (SIGINT/SIGTERM): the HTTP server stops, then
  `daemon.pid` and `daemon.port` are removed. `daemon.log` is kept.
- **SIGKILL / crash**: leftover files never block a restart. The next
  `daemon run` detects that the recorded pid is dead (or the file is garbage),
  logs `removed stale pid file (pid N)`, overwrites it, and proceeds.
- **"factoryd already running (pid N)"** with a daemon you believe is gone:
  check the pid (`ps -p N`). If it is genuinely dead the next start will
  proceed on its own; the message only appears while the recorded pid is
  alive. Removing `daemon.pid` by hand is the escape hatch of last resort.

## Next slices (#764)

launchd packaging and `factory daemon start|stop|status|logs` verbs are
follow-ups; they will read `daemon.pid`/`daemon.port` from `dirname(registry)`
and must not introduce a second state root (ADR-0076).

## Explicit issue runs

The foreground daemon executes explicit issue commands against **attached, active,
initialized local checkouts**. It launches the installed `factory ship` command,
using the checkout's routing configuration and the user's local provider CLI
credentials. `ship` stops at a pull request; the daemon also removes inherited
`FACTORY_MERGE` and `FACTORY_MERGE_ADMIN` flags. Repositories with an external
`stateRoot` are currently rejected because this command uses repository-local
factory state.

| Request                    | Response                                          |
| -------------------------- | ------------------------------------------------- |
| `POST /runs`               | `202 { "run": FactoryRun }`                       |
| `GET /runs`                | `200 { "runs": FactoryRun[] }`                    |
| `GET /runs/:runId`         | `200 { "run": FactoryRun }`                       |
| `GET /runs/:runId/logs`    | `200 { "text": "...", "truncated": false }`       |
| `POST /runs/:runId/cancel` | `200 { "run": FactoryRun }` after execution stops |

Submit JSON with `runId` (a caller-generated UUID), `repo` (`owner/name`), and
`issue` (positive integer). An optional `expiresAt` ISO timestamp limits when
execution may **start**; a queued command that expires fails without launching.

```bash
curl --fail-with-body http://127.0.0.1:8787/runs \
  -H 'content-type: application/json' \
  -d '{"runId":"97c4692b-9492-4d22-92a8-c2e0e5420dc4","repo":"owner/repo","issue":123}'
```

A retry with the same UUID, repository, issue, and deadline returns the existing
run. Reusing a UUID for a different command, submitting an already-active issue,
or using an unavailable repository returns `409`. Invalid input returns `400`;
unknown runs return `404`; stopping/unavailable execution returns `503`. One run
executes at a time; accepted commands wait in a persisted queue.

`FactoryRun` contains `runId`, `repo`, `issue`, `status`, `createdAt`, `updatedAt`,
`startedAt`, `finishedAt`, `exitCode`, `summary`, and `prUrl`. Status is one of
`queued`, `running`, `succeeded`, `failed`, `interrupted`, or `canceled`.
Unavailable start/finish times, exit code, and PR URL are `null`. Success requires
both a zero CLI exit code and its terminal issue-to-PR result. A skipped issue
without a PR result is a failure. Inspect the PR's CI checks before merging.

Commands and bounded log tails are atomically stored in `runs.json` beside the
registry. Logs are stripped of terminal escape sequences and known credential
patterns, checkpointed during execution, and limited to 128 Ki characters per run.
The child receives `FACTORY_RUN_ID` for correlation. The API accepts loopback Host
headers and rejects browser Origins other than its own exact HTTP origin.

SIGINT/SIGTERM interrupts outstanding runs and stops the subprocess group, with
SIGKILL escalation after five seconds. Execution is limited to two hours. A
separate launcher watches the daemon's lifetime even if the CLI is CPU-blocked;
if the daemon dies, the launcher kills its own process group. The launcher PID is
persisted **before** the CLI is permitted to start. On restart, previous active
runs become `interrupted` and are never replayed automatically. While a recorded
launcher PID remains alive, new execution is refused. Recovery does not signal
persisted PIDs, because a PID may have been reused. Inspect the reported process,
worktree, and PR before creating a new run after interruption.

Daemon-managed provider commands also retain their own process-group watchdogs,
so a detached Codex/Claude/checker process cannot escape cleanup when its CLI
parent dies. `run-groups/<runId>.ndjson` records each group owner before the
command is allowed to start. A restart checks these owners as well as the main
launcher; unresolved live owners block new execution. These ownership records
are removed once every process has stopped.

The local pilot retains historical run records and one bounded log tail per run.
Log checkpoints are coalesced to at most one per second while a run is active;
state transitions persist immediately. This is a local history store, not a
high-volume logging backend. Stop the daemon before taking an archival copy of
its state directory; do not delete ownership records for unresolved runs.
