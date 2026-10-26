# Runbook: factoryd

factoryd is the single long-running, **user-scoped** factory daemon: a
loopback-only HTTP API over the repo registry (`~/.factory/registry.json`,
epic #761). It is one process per user with many repos attached to it —
distinct from the per-repo `factory run` / `factory supervise` processes (and
any per-repo supervisors you run, for example as macOS LaunchAgents), whose state lives in
each checkout's `.factory/` directory.

## Starting it

```bash
factory daemon run [--port N] [--registry FILE]
```

Runs in the foreground and binds loopback only: `127.0.0.1` by default, or
`FACTORYD_HOST` set to `127.0.0.1`, `localhost` or `::1`. Any other value exits 2
before binding with an error naming ADR-0034 (binding to loopback is the
authorization model). `--port` defaults to 8787; `--registry`
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

## Checking for updates

`factory self-update --check [--json] [--update-mode stable|prerelease]` is
read-only: it compares the running version with the npm dist-tags of
`@on-par/factory-cli` and installs nothing. `--json` prints one object:
`installKind`, `prefix`, `channel` (`latest`/`next`), `current`, `candidate`,
`updateAvailable`, `applies`, `error`.

- Exit codes: `0` up to date, `10` update available, `1` error, `2` bad usage.
- `stable` only looks at `latest` and never offers a prerelease version;
  `prerelease` takes the highest of `next` and `latest`.
- A registry or network failure sets `error`, forces `updateAvailable: false`
  and exits 1; it never reports an update.
- `applies` is `true` only for an npm-global install; a source install still
  gets the report but with `applies: false`.

## Next slices (#764)

launchd packaging and `factory daemon start|stop|status|logs` verbs are
follow-ups; they will read `daemon.pid`/`daemon.port` from `dirname(registry)`
and must not introduce a second state root (ADR-0076).

## Durable explicit runs and isolated lanes

The CLI daemon installs a supervised executor. `GET /capabilities` reports
`run.execution-config.v1` and `run.isolated-lanes.v1`. `POST /runs` accepts a UUID
`runId`, attached repository slug, positive issue number, optional frozen
`executionConfig`, optional `expiresAt`, and optional integer `laneId` (1–8).
Omitting the lane preserves the single sequential queue. Different lanes execute
concurrently; each lane remains FIFO. Reusing a run ID with different inputs is
rejected, and replaying the same request returns its retained state.

`GET /runs`, `GET /runs/<id>`, and `GET /runs/<id>/logs` expose durable state.
`POST /runs/<id>/cancel` cancels only that delivery. The listener accepts only
same-origin loopback requests. Existing per-file run records remain readable.

Lane execution owns a Git worktree under the repository's Git common directory,
`factory-runs/<runId>`, with a unique run branch prefix and independent factory
state. Preserve `runs.json` and `run-groups/` beside the registry during upgrades.
Port leases are shared through `port-leases/` beside the registry. Stop or drain
active work before upgrading: restart retains unfinished runs as interrupted and
never implicitly replays them. Inspect retained worktrees and PRs before retrying
with a new run ID; worktree cleanup is manual.

See [state-root.md](./state-root.md) for keeping state and config outside the checkout.

## Docker deploy

A Docker image and compose recipe in `deploy/docker/` run factoryd on a Linux
server (#3685). Docker Desktop on macOS or Windows is not a supported target.

**Auth model.** factoryd's HTTP API has no authentication; loopback binding is its
authorization (ADR-0034). The compose file therefore uses `network_mode: host`
and never a `ports:` mapping, so factoryd binds the host's `127.0.0.1` and is
reachable only from the host itself. A non-loopback `FACTORYD_HOST` exits 2
naming ADR-0034. Remote access needs a new ADR with real authentication.

**Bring-up.**

```bash
cd deploy/docker
cp .env.example .env   # set FACTORY_VERSION, FACTORY_REPO_DIR and the secrets
docker compose up -d --build
```

**Secrets.** Credentials (`GH_TOKEN`, `ANTHROPIC_API_KEY`, ...) come only from
`env_file: .env` at runtime. The image bakes none, so `docker history` shows no
secret values. Never commit `.env`.

**Attach a repo.** The checkout at `FACTORY_REPO_DIR` is mounted at `/repos/app`:

```bash
docker compose exec factoryd node -e "fetch('http://127.0.0.1:8787/repos',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({repo:'OWNER/NAME',path:'/repos/app'})}).then(r=>r.text()).then(console.log)"
```

**Health.** The image `HEALTHCHECK` calls `GET /capabilities`:
`docker compose ps` or `docker inspect --format '{{.State.Health.Status}}' <container>`.

**Update.** Self-update is `manual` in the container; the pinned version is the
update channel. Bump `FACTORY_VERSION` in `.env` and run
`docker compose up -d --build`. No host npm install is needed.
