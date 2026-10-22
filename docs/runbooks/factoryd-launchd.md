# factoryd as a launchd LaunchAgent

Reference: #1179 (epic #764). launchd is the macOS service option for factoryd. On Linux or
other hosts, run `factory daemon` under your own service manager. `factory daemon start` installs
`~/Library/LaunchAgents/com.onpar.factoryd.plist` with `KeepAlive` + `RunAtLoad`, so
launchd relaunches factoryd after any crash and starts it at login. The agent runs in
the `gui/<uid>` domain, which keeps login-keychain access. That is needed only when workers
use a Claude subscription login on macOS; with `ANTHROPIC_API_KEY` or another provider it is
not. See [the optional keychain recipe](./macos-keychain-launchagent.md).
launchd redirects factoryd's stdout/stderr to `~/.factory/daemon.log`.

## Install & verify KeepAlive

```sh
factory daemon start     # writes the plist, bootstraps it into gui/<uid>, prints the pid
factory daemon status    # running (pid N, uptime …), plist + log paths, attached repos
kill <pid>               # simulate a crash
factory daemon status    # a NEW pid — launchd relaunched factoryd
factory daemon logs -f   # watch the daemon log live (Ctrl-C to stop)
```

`start` is always a full reinstall: it regenerates the plist (resolving the node binary
and CLI script paths at install time), boots out any loaded copy, and bootstraps fresh.
Re-run it after moving or upgrading the CLI in place — the recorded paths go stale.

## Day-2 operations

- `factory daemon status` — pid, uptime, plist install state, and each attached repo
  (slug + state) from `~/.factory/registry.json`. Exit 0 when running, 1 when not.
- `factory daemon status --json` — prints one JSON object (schemaVersion 1) for tools
  (`running`, `pid`, `uptimeSec`, `plistInstalled`, `repos`, `load`). `load.activeRuns` counts
  `~/.factory/runs.json` entries whose `executionPid` is alive, `load.queueDepth` counts entries with
  status `queued`, and `load.maxSlots` is `host.maxAgentJobs` from the factory config (default 1);
  each is `null` when it cannot be computed (it never fails the command). Unlike `start`, `stop` and
  plain `status` (macOS-only), `--json` also works on Linux: the pid comes from `~/.factory/daemon.pid`
  (counted only if the process is alive) and `plistInstalled` is false.
- `factory daemon logs [-n N] [-f]` — last N lines (default 100) of
  `~/.factory/daemon.log`; `-f` keeps tailing.
- `factory daemon stop` — unloads the agent (launchd stops relaunching). The plist
  stays on disk; `factory daemon start` re-enables it.
- Updates, rollback and exit code 75: see [../ops/updating.md](../ops/updating.md).

## Incremental migration: daemon + cron coexistence

You do not have to move every repo to the daemon at once. The rule: **a repo is
managed by exactly one supervisor** — attached to factoryd XOR driven by a cron
relaunch line. Never both, or the repo gets two engines.

Migrate one repo (repo A) while repo B stays on cron:

1. Remove repo A's cron relaunch line (`crontab -e`) — do this _before_ attaching.
2. Attach repo A to the daemon (attach/detach are HTTP-only; default port 8787):

   ```sh
   curl -X POST http://127.0.0.1:8787/repos \
     -d '{"repo":"owner/repo-a","path":"/abs/path/to/repo-a"}'
   ```

3. Leave repo B's crontab line alone.
4. Check exactly one engine per repo: `ps` for the engine processes, then
   `lsof -a -p <pid> -d cwd` to confirm which repo each process belongs to (all
   factory runs share one command line, so cwd is the only reliable identity).

## Rollback

1. Detach the repo (`curl -X DELETE http://127.0.0.1:8787/repos/owner/repo-a`) —
   or `factory daemon stop` to take the whole daemon down.
2. Re-add that repo's crontab relaunch line.

Nothing else to undo: the plist on disk is inert while unloaded, and the registry
keeps detached entries as tombstones.
