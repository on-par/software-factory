# CLAUDE.md

See [AGENTS.md](./AGENTS.md) for full project context, repository layout, commands, and conventions.

Key reminder — before committing, run the full verification gate and make sure it is green:

```bash
bash scripts/verify.sh --no-e2e
```

This runs build, typecheck, lint, format check, knip (dead code / unused deps), test (with coverage thresholds), and the stub eval — the same checks CI enforces. `--no-e2e` only skips the coverage run; both paths are otherwise the same suite. The pipeline integration tests (real git worktrees) are no longer in either path — they run nightly via `.github/workflows/nightly-integration.yml`, or on demand with `npm run test:integration` (#755).

Merge policy: `main` must always be green. Never bypass a required check that is genuinely `FAILURE` (`gh pr merge --admin` or equivalent) — see AGENTS.md's "Merge policy" section for the two narrow legitimate exceptions and why.
