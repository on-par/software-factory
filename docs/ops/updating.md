# Updating factoryd

Reference: parent #1936, epic #2243. How factoryd updates itself, how to opt out, and
how to roll back by hand. Parts of the flow are not shipped yet; each is marked with a
"Not shipped yet" note and its tracking issue.

## Update modes

| Mode         | npm dist-tag | Default when                             |
| ------------ | ------------ | ---------------------------------------- |
| `manual`     | none         | any non-npm install (source)             |
| `stable`     | `latest`     | factoryd runs from an npm-global install |
| `prerelease` | `next`       | never; opt in explicitly                 |

Precedence, highest first:

1. `--update-mode <mode>` flag.
2. The deprecated `--auto-update` flag (same as `stable`; prints a deprecation notice).
3. `autoUpdate.mode` in `~/.factory/daemon.json` (next to `~/.factory/registry.json`).
4. The default from the table above.

`autoUpdate` in `daemon.json` also accepts `checkIntervalMinutes` (default 30) and
`drainTimeoutMinutes` (default 60). An invalid mode exits with code 2.

Every merge to `main` that passes CI publishes a new `next` prerelease (`X.Y.Z-next.N`, where `X.Y.Z` is
`latest` with the patch bumped), so `prerelease` tracks main. Stable releases still come
from a pushed `vX.Y.Z` tag.

A non-npm install that asks for `stable` or `prerelease` prints
`update mode <m> needs an npm install; staying manual` and stays manual.

## Opting out

```sh
factory factoryd --update-mode manual
```

or in `~/.factory/daemon.json`:

```json
{ "autoUpdate": { "mode": "manual" } }
```

If you pass the flag through the LaunchAgent plist, re-run `factory daemon start` so
the plist is regenerated. The `daemon.json` route needs no plist change.

## The update cycle

> **Not shipped yet (#1939, #2355).** This section describes the planned behaviour.

1. Drain: stop claiming new issues and let in-flight lanes finish, bounded by
   `drainTimeoutMinutes`. `update.draining` in `factory status --json` shows it.
2. Install the exact version into the running Node's prefix.
3. Run `factory doctor`.
4. Restart (see exit code 75 below).

## Rollback

Automatic (not shipped yet, #1939): if install or doctor fails, the previous version is
reinstalled and `lastResult.outcome` is `rolled-back`. Failed versions are skipped.

Manual rollback:

```sh
npm i -g --prefix <prefix> @on-par/factory-cli@<previous>
factory daemon stop && factory daemon start
```

- `<previous>`: `lastResult.version` or `current` in `factory status --json`, or pick
  one from `npm view @on-par/factory-cli versions`.
- `<prefix>`: `dirname $(dirname $(which node))` for the Node that runs factoryd.

## Restart under launchd (exit code 75)

> **Not shipped yet (#1939).**

After a successful install factoryd exits with code 75 (EX_TEMPFAIL) and launchd
`KeepAlive` relaunches it on the new version. An exit-75 line in `~/.factory/daemon.log`
is not a crash. See [the launchd runbook](../runbooks/factoryd-launchd.md).

## Update state in factory status --json

State lives in `~/.factory/update-state.json`. `factory status --json` reports it in the
`update` object, which is `null` when there is no readable state file:

```json
{
  "update": {
    "mode": "stable",
    "channel": "latest",
    "installKind": "npm-global",
    "current": "1.2.3",
    "available": "1.2.4",
    "lastCheckAt": "2026-01-01T00:00:00.000Z",
    "lastResult": {
      "at": "2026-01-01T00:00:00.000Z",
      "version": "1.2.3",
      "outcome": "updated",
      "error": "only present on failure"
    },
    "draining": { "since": "2026-01-01T00:00:00.000Z", "target": "1.2.4" }
  }
}
```

`outcome` is one of `updated`, `rolled-back`, `failed`, `skipped`.

## Machine note: nvm and wrapper launchers

Runners started through a wrapper such as `~/.local/bin/factory` on nvm Node 24 must
install into that Node's prefix:

```sh
npm i -g --prefix ~/.nvm/versions/node/<ver> @on-par/factory-cli@<version>
```

A stray global prefix (`npm config get prefix`, or `prefix=` in `~/.npmrc`) can install
into a different Node, so the runner keeps the old version. Check what the runner's Node
has:

```sh
npm ls -g --prefix ~/.nvm/versions/node/<ver> @on-par/factory-cli
```

## Source checkouts never auto-update

`FACTORY_FROM_SOURCE=1`, or a `cli.js` inside a git checkout, is classified `source`.
The mode is forced to manual and the notice above appears. Update with:

```sh
git pull && npm ci && npm run build
```
