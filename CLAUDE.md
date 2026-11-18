# CLAUDE.md

Read [AGENTS.md](./AGENTS.md) first. It holds the project rules and the list of repo skills.

Before committing, run `bash scripts/verify.sh --no-e2e` from the repo root and make sure it is green. Exception: a factory BUILD under the focused handoff in `.factory/constitution.md` runs the focused commands before each commit, and CHECK runs the full gate before SHIP. The `verify` skill explains each step and how to fix failures.

`main` must always be green. Never bypass a required check that is genuinely `FAILURE`. The `merge-policy` skill covers the two narrow exceptions.
