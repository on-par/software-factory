# CLI JSON Schemas

The CLI publishes JSON Schemas for its eight read-only `--json` output contracts. The schemas use JSON Schema draft 2020-12, which is the default output of [Zod's JSON Schema conversion](https://zod.dev/json-schema). Validate them with a draft 2020-12 implementation such as Ajv's [`Ajv2020` class](https://ajv.js.org/json-schema.html#draft-2020-12).

Each schema is generated from the corresponding named Zod export in `packages/cli/src/cli/json-contract.ts`. The fixtures live in [`packages/cli/src/cli/__fixtures__/json/`](../packages/cli/src/cli/__fixtures__/json/).

| Command                                   | Schema                                                                           | Fixture                                                                              | Version                                       |
| ----------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------- |
| `factory status --json`                   | [`status.schema.json`](../packages/cli/schemas/status.schema.json)               | [`status.json`](../packages/cli/src/cli/__fixtures__/json/status.json)               | `schemaVersion` is `1`                        |
| `factory logs --json` (one NDJSON record) | [`logs-line.schema.json`](../packages/cli/schemas/logs-line.schema.json)         | [`logs-line.json`](../packages/cli/src/cli/__fixtures__/json/logs-line.json)         | Legacy unversioned record; no `schemaVersion` |
| `factory daemon status --json`            | [`daemon-status.schema.json`](../packages/cli/schemas/daemon-status.schema.json) | [`daemon-status.json`](../packages/cli/src/cli/__fixtures__/json/daemon-status.json) | `schemaVersion` is `1`                        |
| `factory queue list --json`               | [`queue-list.schema.json`](../packages/cli/schemas/queue-list.schema.json)       | [`queue-list.json`](../packages/cli/src/cli/__fixtures__/json/queue-list.json)       | `schemaVersion` is `1`                        |
| `factory usage --json`                    | [`usage.schema.json`](../packages/cli/schemas/usage.schema.json)                 | [`usage.json`](../packages/cli/src/cli/__fixtures__/json/usage.json)                 | `schemaVersion` is `1`                        |
| `factory cost --json`                     | [`cost.schema.json`](../packages/cli/schemas/cost.schema.json)                   | [`cost.json`](../packages/cli/src/cli/__fixtures__/json/cost.json)                   | `schemaVersion` is `1`                        |
| `factory runs --json`                     | [`runs.schema.json`](../packages/cli/schemas/runs.schema.json)                   | [`runs.json`](../packages/cli/src/cli/__fixtures__/json/runs.json)                   | `schemaVersion` is `1`                        |
| `factory runs --diffstat --json`          | [`runs-diffstat.schema.json`](../packages/cli/schemas/runs-diffstat.schema.json) | [`runs-diffstat.json`](../packages/cli/src/cli/__fixtures__/json/runs-diffstat.json) | `schemaVersion` is `1`                        |

The seven versioned envelopes generate a `schemaVersion` constant of `1`. Logs output is one NDJSON record per line and deliberately remains unversioned. Its optional event payloads permit arbitrary object keys as defined by the existing CLI contract.

Regenerate schemas from the repository root with:

```sh
npx tsx scripts/gen-cli-json-schemas.ts packages/cli/schemas
```

Check that committed artifacts match the current Zod definitions with:

```sh
bash scripts/check-cli-json-schemas.sh
```

The CLI npm package includes these files under its installed `schemas/` directory (for example, `node_modules/@on-par/factory-cli/schemas/status.schema.json`).
