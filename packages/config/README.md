# @on-par/factory-config

Typed shipped defaults (models, routes, factory settings) and the bundled constitution markdown for the Software Factory. Zero runtime dependencies.

Part of [Software Factory](https://github.com/on-par/software-factory), a multi-agent factory that ships verified work autonomously. Most users want the CLI, [`@on-par/factory-cli`](https://www.npmjs.com/package/@on-par/factory-cli); the other packages are its building blocks.

## Contents

- `defaultModelsConfig`, `defaultRoutesConfig`, `defaultFactoryConfig` and friends: the shipped defaults as typed values.
- `constitutionsDir` / `resolveConfigPath()`: paths to the bundled constitution markdown, which ships under `dist/constitutions/` and is also exported as `@on-par/factory-config/constitutions/*`.

## Documentation

- [README and Quick Start](https://github.com/on-par/software-factory#readme)
- [Architecture and package graph](https://github.com/on-par/software-factory/blob/main/docs/architecture.md)
- [Changelog](https://github.com/on-par/software-factory/blob/main/CHANGELOG.md)

## License

MIT. See [LICENSE](./LICENSE).
