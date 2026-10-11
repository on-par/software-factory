# @on-par/factory-core

The Software Factory engine: model router, PLAN/BUILD/CHECK/SHIP phases, checkers, queue, events and cost tracking.

Part of [Software Factory](https://github.com/on-par/software-factory), a multi-agent factory that ships verified work autonomously. Most users want the CLI, [`@on-par/factory-cli`](https://www.npmjs.com/package/@on-par/factory-cli); the other packages are its building blocks.

## Entry points

| Import                          | Stability                                                                                                                                  |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `@on-par/factory-core`          | Stable public API ([ADR-0004](https://github.com/on-par/software-factory/blob/main/docs/adr/0004-narrow-public-core-api.md))               |
| `@on-par/factory-core/kpis`     | Browser-safe KPI helpers                                                                                                                   |
| `@on-par/factory-core/internal` | Implementation detail for the factory's own packages; may change in any release                                                            |
| `@on-par/factory-core/testing`  | Test doubles and contract kits (stub harnesses, simulators) for exercising the factory without real model CLIs; not part of the stable API |

The repo's own test fixtures (`src/test-support/`) are never published.

## Documentation

- [README and Quick Start](https://github.com/on-par/software-factory#readme)
- [Architecture and package graph](https://github.com/on-par/software-factory/blob/main/docs/architecture.md)
- [Changelog](https://github.com/on-par/software-factory/blob/main/CHANGELOG.md)

## License

MIT. See [LICENSE](./LICENSE).
