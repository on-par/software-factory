# TS 7 lint migration

The previous lint stack could not run against TypeScript 7 because typescript-eslint supports TypeScript versions below 6.1. This migration replaces it with Oxlint and `oxlint-tsgolint`, which uses the TypeScript 7 `typescript-go` backend for type-aware rules.

The repository now uses one npm TypeScript package, `typescript@7.0.2`. The lint command enables Oxlint type-aware analysis and treats warnings as errors. It retains the existing unused-variable, empty-catch, and type-import policies, and adds `typescript/no-floating-promises`.

`simple-import-sort` was removed. Oxlint's native `sort-imports` rule has a different ordering model and reported hundreds of existing, correctly grouped imports. Keeping it would have made this toolchain migration an unrelated repository-wide formatting change. The native rule is therefore not enabled. Import ordering can be revisited when Oxlint gains grouped import sorting compatible with the existing policy.

## Sources

- typescript-eslint dependency support: https://typescript-eslint.io/users/dependency-versions/
- Oxlint type-aware linting: https://oxc.rs/docs/guide/usage/linter/type-aware.html
- tsgolint TypeScript 7 backend and rule coverage: https://github.com/oxc-project/tsgolint
