# Contributing to Software Factory

Thanks for helping. This page is the short version. The project rules live in [AGENTS.md](AGENTS.md), and the architecture overview is in [docs/architecture.md](docs/architecture.md).

## Set up

You need Node.js ≥ 24, `git`, and an authenticated `gh` CLI. From a clone:

```bash
npm install
npm run build
```

## The verify gate

`scripts/verify.sh` is the gate. Run it from the repo root and get it green before every commit:

```bash
bash scripts/verify.sh --no-e2e   # fast pass: format, build, ADR index, typecheck, lint, knip, vitest, stub evals, script tests
bash scripts/verify.sh            # full pass: same, plus coverage thresholds (`npm run test`) and the coverage ratchet
```

- CI runs the full coverage suite on every PR, and `main` must stay green.
- Never lower a coverage threshold in `vitest.config.ts`. If the ratchet says coverage rose, raise the threshold in the same PR.
- Put a colocated `*.test.ts` next to every source change.
- Pipeline integration suites are not part of verify. Run them on demand with `npm run test:integration`.
- To read and fix each failure, see [.claude/skills/verify/SKILL.md](.claude/skills/verify/SKILL.md).

## Try one issue on a throwaway repo

Before you point the factory at a real repo, dogfood it on one issue in a throwaway test repo:

1. Create a scratch GitHub repo you don't mind agents writing to, clone it, and open one small issue in it.
2. Link the CLI from your factory clone: `npm link --workspace @on-par/factory-cli`.
3. In the throwaway repo:

```bash
export GITHUB_TOKEN=$(gh auth token)
factory init
factory doctor
factory run-issue <N>    # PLAN → BUILD → CHECK → SHIP for that one issue
```

The run works in an isolated git worktree and ends at a ready-for-review PR. It never merges unless you opt in with `FACTORY_MERGE=1`, so review the PR yourself. Agents run with permission prompts disabled (see "Open-Core Boundary & Safety" in the [README](README.md)), which is why you should use a throwaway repo.

## Filing work for the factory

File new work with the **Factory task** issue template, [`.github/ISSUE_TEMPLATE/factory-task.yml`](.github/ISSUE_TEMPLATE/factory-task.yml). It asks for the problem statement, in/out of scope, acceptance criteria, and verification that the factory needs to ship an issue on its own. Bugs use `factory-bug.yml`.

## Design decisions

Record significant design decisions as ADRs in [docs/adr/](docs/adr/) (see its README).
