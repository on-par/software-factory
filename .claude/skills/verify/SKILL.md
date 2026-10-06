---
name: verify
description: Run and fix the software-factory verification gate (scripts/verify.sh) from the repo root — format, build, config-JSON and oxlint-plugin guards, typecheck, lint, knip, tests with coverage thresholds and the coverage ratchet, the stub eval, and the shell-script tests. Use before every commit or push, when asked to "run verify", "run the checks", "make CI green", when a CI `ci` job fails, when the coverage ratchet complains, or when running the pipeline integration tests.
---

# Verify

Run every command from the repo root. Tests only resolve from there.

## Which path to run

| When                                         | Command                           |
| -------------------------------------------- | --------------------------------- |
| Before every commit (fast loop)              | `bash scripts/verify.sh --no-e2e` |
| Before you push (matches CI coverage checks) | `bash scripts/verify.sh`          |
| Pipeline integration suites (on demand)      | `npm run test:integration`        |

The factory's own CHECK phase runs `bash scripts/verify.sh --no-e2e` in the build worktree (`packages/core/src/checkers/index.ts`).

## What `scripts/verify.sh` runs, in order

1. `npm ci`
2. `npm run format:check` (Prettier, includes Markdown)
3. `npm run build` (`tsc -b`)
4. `npm run adr:index -- --check` — the ADR index table in `docs/adr/README.md` must match the ADR files
5. `bash scripts/check-config-json.sh` — no JSON may exist under `packages/config/src` or `dist` (#716)
6. `bash scripts/check-oxlint-plugin-version.sh` — `@oxlint/plugins` must match `oxlint` exactly (#795)
7. `npm run typecheck`
8. `npm run lint` — Oxlint, type-aware, `--deny-warnings`
9. `npm run knip` — dead code and unused dependencies
10. Tests:
    - full path: `npm run test` (Vitest with coverage thresholds), then `npm run coverage-ratchet`
    - `--no-e2e`: `npx vitest run` (no coverage, no ratchet)
11. `npm run eval -- --stub`
12. Shell-script tests: `auto-merge-sweep`, `filter-green-prs`, `repo-merge-settings`, `repo-about`, `repo-issue-optics`, `ruleset-copilot-review`, `launchd/install-sweep-plist`, `publish-workspaces` (guards the publish list `scripts/publish-workspaces.txt` against the workspace graph)

CI (`.github/workflows/ci.yml`) runs the same steps as the full path. It also runs `scripts/quickstart-smoke.sh` in a separate job. It does not run the `install-sweep-plist` test.

## Coverage gate and ratchet

- Thresholds live in `vitest.config.ts`: one global set plus one set per package. Read the file for the current numbers.
- A drop below any threshold fails `npm run test`. Add tests. Never lower a threshold.
- `npm run coverage-ratchet` fails when measured coverage beats a threshold by more than 2 points (`DEFAULT_RATCHET_SLACK`). Raise that threshold to the suggested value it prints, in the same PR.
- `packages/core/src/types/**` and `packages/core/src/test-support/**` are excluded from coverage.

## Integration tests

`*.integration.test.ts` files (real git worktrees, whole plan → build → check → ship cycles) are excluded from both verify paths. They run nightly in `.github/workflows/nightly-integration.yml` (07:00 UTC). Run them with `npm run test:integration` when you touch `packages/core/src/phases/` or worktree handling.

`npm run mutation` (Stryker) runs on demand only. It is not part of `scripts/verify.sh` and CI does not run it (#805).

## Fixing common failures

| Failing step                              | Fix                                                                                                                                       |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `format:check`                            | `npm run format`, then re-run.                                                                                                            |
| `adr:index --check`                       | `npm run adr:index`, commit the README change. If it names an unparseable ADR, fix that file's `# ADR-NNNN:` heading or `- Status:` line. |
| `check-config-json`                       | Move the data into `packages/config/src/defaults.ts` as typed TS. Delete the JSON file.                                                   |
| `check-oxlint-plugin…`                    | Bump `oxlint` and `@oxlint/plugins` to the same version in `package.json`, then `npm install`.                                            |
| `lint`                                    | Fix the code. Warnings fail the build too.                                                                                                |
| `knip`                                    | Delete the unused export, file, or dependency.                                                                                            |
| `test` threshold                          | Add tests for the uncovered lines the report names.                                                                                       |
| `coverage-ratchet`                        | Raise the named threshold in `vitest.config.ts` to the suggested value.                                                                   |
| `eval --stub`                             | See the `run-evals` skill.                                                                                                                |
| Tests pass in root, fail inside a package | Expected. Run from the repo root. Do not change `packages/core/package.json`'s `test` script.                                             |
