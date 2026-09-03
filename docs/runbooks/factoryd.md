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
