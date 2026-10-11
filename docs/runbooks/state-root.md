# Keeping factory state outside the checkout

By default factory state and the repo config live in `<checkout>/.factory/`. Set a **state root** to keep them elsewhere, so the checkout carries no `.factory/` (#2281).

## Setting it

- `FACTORY_STATE_ROOT=<value>` in the environment, or
- `factory --state-root <value> <command>` (the flag wins over the env var and is exported, as an absolute path, to child processes such as lanes and CHECK).

Accepted values:

| Value         | Root                                                              |
| ------------- | ----------------------------------------------------------------- |
| unset / blank | `<checkout>/.factory` (unchanged)                                 |
| `auto`        | `~/.factory/<owner>/<name>/`, from the checkout's `origin` remote |
| `~` or `~/x`  | under your home directory                                         |
| absolute path | that path                                                         |

Relative paths are rejected (lanes run in other working directories, so they would resolve differently). `auto` fails if `origin` does not parse to `owner/name`. The CLI exits 2 on an invalid value.

## Precedence

1. Explicit registry `stateRoot` (factoryd)
2. `--state-root`
3. `FACTORY_STATE_ROOT`
4. `<checkout>/.factory`

## Config

Under a state root, config is `<stateRoot>/config.{yaml,yml,json}`, else defaults + env. An in-repo `.factory/config.*` is ignored while a state root is set.

## factoryd attach

`POST /repos` accepts an optional `stateRoot` (absolute path or `auto`): `{ "repo": "owner/name", "path": "/abs/checkout", "stateRoot": "auto" }`. With a state root, a checkout without `.factory/config.json` is accepted and the registry entry records `stateRoot`. Re-attaching keeps an existing entry's `stateRoot`. Explicit factoryd runs still require repository-local state.

## Migration

Moving existing repos is manual:

1. `mkdir -p ~/.factory/<owner>/<name>`
2. Move `.factory/config.*`, `.factory/constitution.md` and `.factory/state/` there.
3. Set `FACTORY_STATE_ROOT=auto` (or pass `--state-root auto`).
