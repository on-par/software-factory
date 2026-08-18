# CLAUDE.md

See [AGENTS.md](./AGENTS.md) for full project context, repository layout, commands, and conventions.

Key reminder — before committing, run the full verification gate and make sure it is green:

```bash
bash scripts/verify.sh --no-e2e
```

This runs build, typecheck, lint, format check, knip (dead code / unused deps), test (with coverage thresholds), and the stub eval — the same checks CI enforces. Use `--no-e2e` locally: the bare path also runs the pipeline integration tests, which have a known intermittent multi-hour deadlock (#739); real CI still runs the full suite on the PR regardless.

Merge policy: `main` must always be green. Never bypass a required check that is genuinely `FAILURE` (`gh pr merge --admin` or equivalent) — see AGENTS.md's "Merge policy" section for the two narrow legitimate exceptions and why.
