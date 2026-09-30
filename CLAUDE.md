# CLAUDE.md

Read [AGENTS.md](./AGENTS.md) first. It holds the project rules and the list of repo skills.

Before committing, run `bash scripts/verify.sh --no-e2e` from the repo root and make sure it is green. The `verify` skill explains each step and how to fix failures.

`main` must always be green. Never bypass a required check that is genuinely `FAILURE`. The `merge-policy` skill covers the two narrow exceptions.
