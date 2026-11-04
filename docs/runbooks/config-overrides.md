# Per-run config and constitution overrides

A host, for example a disposable container, can control a run's config and constitution without writing into the checkout. The sources form one ladder, highest first:

| Rank | Source                                                                    | What it is                                                 |
| ---- | ------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 1    | `FACTORY_CONFIG_OVERRIDES`                                                | A YAML fragment deep-merged over the winner of ranks 2-4   |
| 2    | `--config <path>`, else `FACTORY_CONFIG_PATH`, else `FACTORY_CONFIG_YAML` | A whole-file override; it replaces the repo file wholesale |
| 3    | `.factory/config.yaml` (or `.yml` / `.json`)                              | The repo's file                                            |
| 4    | Packaged defaults                                                         | Used when none of the above exists                         |

Constitutions follow the same idea: `--constitution <path>`, else `FACTORY_CONSTITUTION_PATH`, else inline `FACTORY_CONSTITUTION`, each replacing the repo's `.factory/constitution.md`.

The per-key environment variables that already exist still apply on top of the resolved config.

## Examples

```sh
# A 16 GB disk: lower the free-space floor for this run only.
FACTORY_CONFIG_OVERRIDES=$'disk:\n  minFreeGb: 2' factory run-issue 42

# A container with no OS sandbox runtime.
FACTORY_CONFIG_OVERRIDES=$'sandbox:\n  runtime: none' factory run-issue 42

# Use a config baked into the image, and pin models on top of it.
factory --config /etc/factory/config.yaml run-issue 42
FACTORY_CONFIG_PATH=/etc/factory/config.yaml FACTORY_CONFIG_OVERRIDES=$'models:\n  plan: claude-opus-5-5' factory run-issue 42
```

## Validation

Every override is checked with the same strict schemas as the repo file. A bad override fails before PLAN and the error names the source, for example `Invalid FACTORY_CONFIG_OVERRIDES: bogusKey: Unrecognized key`. The fragment is checked on its own first, so an unknown key is blamed on the fragment, then the merged result is checked and blamed on the winning source.

## Reporting and redaction

`run-issue`, `run-brief`, `ship` and `run` print `factory: config: <source>; constitution: <source>` and record a `config_source` event. `factory doctor` shows a `config sources` row and a `sources` object under `--json`. Only key paths that the fragment changed are listed, never values. A key whose last segment ends in `Env`, or contains `token`, `secret`, `password`, `apikey` or `credential`, is shown as `<redacted key>`.

## A daemon snapshot wins

A run started by the daemon already carries an immutable config snapshot (`FACTORY_RUN_CONFIG_JSON`). That snapshot wins over every override above.
