# Contributing to On PAR Dev's Software Factory

Thanks for helping. This page is the short version. The project rules live in [AGENTS.md](AGENTS.md), and the architecture overview is in [docs/architecture.md](docs/architecture.md).

## Set up

You need Node.js ≥ 24, `git`, one supported coding agent CLI installed and signed in (see [docs/agents.md](docs/agents.md)), and the GitHub CLI signed in with `gh auth login`. Most users install the published CLI with `npm install -g @on-par/factory-cli` (see the [README](README.md)). To work on the factory itself, install it from a clone:

```bash
git clone https://github.com/on-par/software-factory
cd software-factory
npm install
npm run build
npm link --workspace @on-par/factory-cli   # puts your local `factory` on your PATH
factory --version
factory doctor
```

To go back to the published package, run `npm unlink -g @on-par/factory-cli` and then `npm install -g @on-par/factory-cli`.

## The verify gate

`scripts/verify.sh` is the gate. Run it from the repo root and get it green before every commit:

```bash
bash scripts/verify.sh --no-e2e   # format, build, ADR index, config checks, typecheck, lint, knip, vitest with coverage thresholds, stub evals, script tests
bash scripts/verify.sh            # the same, plus the coverage ratchet
```

- Both paths run `npm ci` first and `npm run test` (Vitest with the coverage thresholds in `vitest.config.ts`).
- CI runs the suite as parallel shards on every PR and enforces coverage on the merged report. `main` must stay green.
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

The run works in an isolated git worktree and ends at a ready-for-review PR. `factory run-issue` never merges, even with `FACTORY_MERGE=1`, so review the PR yourself. Agents run with permission prompts disabled (see [Safety](README.md#safety) in the README), which is why you should use a throwaway repo.

## Filing work for the factory

File new work with the **Factory task** issue template, [`.github/ISSUE_TEMPLATE/factory-task.yml`](.github/ISSUE_TEMPLATE/factory-task.yml). It asks for the problem statement, in/out of scope, acceptance criteria, and verification that the factory needs to ship an issue on its own. Bugs use `factory-bug.yml`.

## Steer events

When you or a bot steer a factory run, record it with `factory steer`:

```sh
factory steer 3404 --message "use the new API"
factory steer 3404 --message "switch BUILD to the v2 client" --source bot --actor <id>
```

Capture is opt-in emit only: transcripts are not ingested, and steers must not be hidden to
improve the score. See [docs/ops/steer-events.md](docs/ops/steer-events.md) for the event fields
and the decisions record.

## CHANGELOG and docs

If users or operators can see your change, add a one-line entry under `## Unreleased` in
[CHANGELOG.md](CHANGELOG.md) (`Added`, `Changed` or `Fixed`, with the issue link), and update
the README, `docs/status.md`, `docs/agents.md`, `docs/models.md` or `docs/ops/` in the same PR.
Do not change `package.json` versions: they stay at the last committed version (0.9.21), and the
publish job stamps the release version at build time without committing it. The release steps
and the publish gate are in [docs/ops/docs-and-changelog.md](docs/ops/docs-and-changelog.md).

## Design decisions

Record significant design decisions as ADRs in [docs/adr/](docs/adr/) (see its README).
