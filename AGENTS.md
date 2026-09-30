# AGENTS.md

Software Factory is a TypeScript monorepo (npm workspaces under `packages/`) that ships GitHub issues autonomously through a boss-worker-checker pipeline: PLAN → BUILD → CHECK → SHIP. `core` is the UI-less engine, `cli` is the `factory` command, and `config` holds the typed defaults and constitutions.

## Rules

- Run `bash scripts/verify.sh --no-e2e` and get it green before every commit. Run it from the repo root.
- Never lower a coverage threshold in `vitest.config.ts`. When the ratchet says coverage rose, raise the threshold in the same PR.
- Never merge past a required check that is genuinely `FAILURE` (`gh pr merge --admin` or equivalent). `main` must always be green.
- Write or update the colocated `*.test.ts` next to every source change.
- Keep `packages/config` zero-dependency. The dependency direction is `config ← core ← cli`.
- Model routing lives in `packages/config/src/defaults.ts`. Do not hard-code model lists in `core`.
- `core`'s root export is the narrow public API. Put implementation details behind `@on-par/factory-core/internal` and test helpers behind `@on-par/factory-core/testing` (ADR-0004).
- Import across packages by published name (`@on-par/factory-core`), never by a relative path across a package boundary.
- TypeScript is strict and ESM only. Use `.js` extensions on relative imports.
- Record significant design decisions as ADRs in `docs/adr/` (see its README).

## Known agent traps

- Do not "fix" the `test` script in `packages/core/package.json`. It is intentionally `"test": "vitest run"`. Tests only resolve from the repo root, where coverage is configured. Run `npm run test` there instead.

## Skills

Step-by-step procedures live in `.claude/skills/`. Read the matching `SKILL.md` before you do the task.

- `verify` — what the verify gate runs, how to read and fix each failure, coverage ratchet, integration tests.
- `merge-policy` — landing PRs, the two legitimate bypass cases, what to do when `main` is red.
- `run-evals` — stub, single-case, and full LLM-judge eval runs and baseline comparison.
