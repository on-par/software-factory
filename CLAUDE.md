# CLAUDE.md

See [AGENTS.md](./AGENTS.md) for full project context, repository layout, commands, and conventions.

Key reminder — before committing, run the full verification gate and make sure it is green:

```bash
bash scripts/verify.sh
```

This runs build, typecheck, lint, format check, knip (dead code / unused deps), test (with coverage thresholds), and the stub eval — the same checks CI enforces.
