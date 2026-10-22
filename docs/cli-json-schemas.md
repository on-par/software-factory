# CLI JSON Schemas

The CLI publishes JSON Schemas for thirteen `--json` output contracts: twelve versioned envelopes and one legacy unversioned log record. The schemas use JSON Schema draft 2020-12, which is the default output of [Zod's JSON Schema conversion](https://zod.dev/json-schema). Validate them with a draft 2020-12 implementation such as Ajv's [`Ajv2020` class](https://ajv.js.org/json-schema.html#draft-2020-12).

Each schema is generated from the corresponding named Zod export in `packages/cli/src/cli/json-contract.ts`. The canonical fixtures live in [`packages/cli/src/cli/__fixtures__/json/`](../packages/cli/src/cli/__fixtures__/json/), except queue add, whose fixture remains at [`packages/cli/src/cli/__fixtures__/queue-add.json`](../packages/cli/src/cli/__fixtures__/queue-add.json).

| Command                                        | Schema                                                                           | Fixture                                                                              | Version                                                                                                      |
| ---------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `factory status --json`                        | [`status.schema.json`](../packages/cli/schemas/status.schema.json)               | [`status.json`](../packages/cli/src/cli/__fixtures__/json/status.json)               | `schemaVersion` is `1`                                                                                       |
| `factory logs --json` (one NDJSON record)      | [`logs-line.schema.json`](../packages/cli/schemas/logs-line.schema.json)         | [`logs-line.json`](../packages/cli/src/cli/__fixtures__/json/logs-line.json)         | Legacy unversioned record; no `schemaVersion`                                                                |
| `factory daemon status --json`                 | [`daemon-status.schema.json`](../packages/cli/schemas/daemon-status.schema.json) | [`daemon-status.json`](../packages/cli/src/cli/__fixtures__/json/daemon-status.json) | `schemaVersion` is `1`; additive `load` `{activeRuns, maxSlots, queueDepth}` (each nullable); works on Linux |
| `factory queue list --json`                    | [`queue-list.schema.json`](../packages/cli/schemas/queue-list.schema.json)       | [`queue-list.json`](../packages/cli/src/cli/__fixtures__/json/queue-list.json)       | `schemaVersion` is `1`                                                                                       |
| `factory usage --json`                         | [`usage.schema.json`](../packages/cli/schemas/usage.schema.json)                 | [`usage.json`](../packages/cli/src/cli/__fixtures__/json/usage.json)                 | `schemaVersion` is `1`                                                                                       |
| `factory cost --json`                          | [`cost.schema.json`](../packages/cli/schemas/cost.schema.json)                   | [`cost.json`](../packages/cli/src/cli/__fixtures__/json/cost.json)                   | `schemaVersion` is `1`                                                                                       |
| `factory runs --json`                          | [`runs.schema.json`](../packages/cli/schemas/runs.schema.json)                   | [`runs.json`](../packages/cli/src/cli/__fixtures__/json/runs.json)                   | `schemaVersion` is `1`                                                                                       |
| `factory runs --diffstat --json`               | [`runs-diffstat.schema.json`](../packages/cli/schemas/runs-diffstat.schema.json) | [`runs-diffstat.json`](../packages/cli/src/cli/__fixtures__/json/runs-diffstat.json) | `schemaVersion` is `1`                                                                                       |
| `factory queue add --json`                     | [`queue-add.schema.json`](../packages/cli/schemas/queue-add.schema.json)         | [`queue-add.json`](../packages/cli/src/cli/__fixtures__/queue-add.json)              | `schemaVersion` is `1`                                                                                       |
| `factory stop --json`                          | [`stop.schema.json`](../packages/cli/schemas/stop.schema.json)                   | [`stop.json`](../packages/cli/src/cli/__fixtures__/json/stop.json)                   | `schemaVersion` is `1`                                                                                       |
| `factory resume --json`                        | [`resume.schema.json`](../packages/cli/schemas/resume.schema.json)               | [`resume.json`](../packages/cli/src/cli/__fixtures__/json/resume.json)               | `schemaVersion` is `1`                                                                                       |
| `factory unpark --json`                        | [`unpark.schema.json`](../packages/cli/schemas/unpark.schema.json)               | [`unpark.json`](../packages/cli/src/cli/__fixtures__/json/unpark.json)               | `schemaVersion` is `1`                                                                                       |
| `factory unpark <issue...> --json` (2+ issues) | [`unpark-batch.schema.json`](../packages/cli/schemas/unpark-batch.schema.json)   | [`unpark-batch.json`](../packages/cli/src/cli/__fixtures__/json/unpark-batch.json)   | `schemaVersion` is `1`; success results are `unpark.schema.json` items                                       |

The twelve versioned envelopes generate a `schemaVersion` constant of `1`. Logs output is one NDJSON record per line and deliberately remains unversioned. Its optional event payloads permit arbitrary object keys as defined by the existing CLI contract. Future JSON support for `land` (#2279), `metrics` (#3130), and `requeue` (#2278) must add a schema and golden fixture.

Regenerate schemas from the repository root with:

```sh
npx tsx scripts/gen-cli-json-schemas.ts packages/cli/schemas
```

Check that committed artifacts match the current Zod definitions with:

```sh
bash scripts/check-cli-json-schemas.sh
```

The CLI npm package includes these files under its installed `schemas/` directory (for example, `node_modules/@on-par/factory-cli/schemas/status.schema.json`).
