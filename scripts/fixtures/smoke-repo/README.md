# Smoke-repo fixture

A tiny, dependency-free source tree plus a factory config template, used as the shared target of adapter smoke runs (#2653, #2679). The smoke script copies the tree into a temp dir, runs `git init`, and writes the rendered config to `.factory/config.yaml`.

## Layout

- `package.json`, `src/greet.mjs`: the tiny package. Not an npm workspace.
- `test/greet-check.mjs`: the fixture's check, run by `npm test`. It is deliberately not named `*.test.*`, so neither vitest nor `node --test` discovers it.
- `factory-config.template.yaml`: a v2 repo config. A single `__SMOKE_AGENT__` placeholder picks the agent for every pin (plan, build, checker, triage). The registry overlay declares `smoke-codex`, `smoke-opencode` and `smoke-command`.
- `render-config.sh`: substitutes the placeholder and prints the config to stdout.
- `smoke-repo.test.ts`: checks the tree and that every rendered config loads and pins the right agent.

## Usage

Allowed values are `codex`, `opencode` and `command`. Anything else exits 2 with a usage message.

```sh
bash scripts/fixtures/smoke-repo/render-config.sh codex > <repo>/.factory/config.yaml
```

## Caveats

- The opencode variant needs `FACTORY_EXPERIMENTAL=1`.
- The command variant selects the command harness, but it needs a matching `harnesses:` declaration in the models config before it can run. A repo `.factory/config.yaml` has no such section yet, so it cannot run end to end until the adapter-smoke slice provides one.
