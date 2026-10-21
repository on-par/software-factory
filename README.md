# On PAR Dev's Software Factory

On PAR Dev's Software Factory is a local CLI that takes a GitHub issue through plan, build and check with AI agents, then opens a ready-for-review PR. You decide what merges.

Built in TypeScript. Routes work across Claude and Codex, with experimental local models through Ollama, and logs cost per task.

![On PAR Dev's Software Factory running a lane on a real product repo (sped up)](https://raw.githubusercontent.com/on-par/software-factory/main/docs/assets/factory-run.gif)

For an example of its output, see [#2288](https://github.com/on-par/software-factory/pull/2288): the factory planned and built issue #2269 (`factory cost --json`), ran its checkers (7 pass, 1 rework round), opened the PR with an evidence pack comment, and CI passed. Merging was a separate step.

## Status

What works today (this table matches the code on main):

| Feature                                               | Status     | Notes                                                                                                            |
| ----------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------- |
| `factory ship` pipeline (PLAN → BUILD → CHECK → SHIP) | ✅ Working | Covered by an end-to-end pipeline integration test                                                               |
| `factory triage` (queue from open issues)             | ✅ Working |                                                                                                                  |
| `factory run` (parallel lanes)                        | ✅ Working | Merges are serialized per lane via a merge-wait step                                                             |
| `factory land` / auto-merge                           | ✅ Working | Off by default. Turn on with `FACTORY_MERGE=1`, `run.merge.auto: true` or `--auto-merge`; see [Safety](#safety). |
| `factory supervise` (multi-window unattended runs)    | ✅ Working | Waits for usage headroom, runs the queue, repeats until drained                                                  |
| Cost tracking (`factory cost`)                        | ✅ Working | Per-task tokens and cost logged to `.factory/state/costs.jsonl`                                                  |

The full matrix, including model harnesses, prompt evals, the server, and experimental local (Ollama) models, is in [docs/status.md](docs/status.md).

## Monorepo structure

An npm-workspaces monorepo:

```
packages/
├── adr-kit/          @on-par/adr-kit            pure ADR kernel (zero deps)
├── cli/              @on-par/factory-cli        the `factory` command
├── config/           @on-par/factory-config     typed defaults + constitutions in TypeScript (zero deps)
├── contracts/        @on-par/contracts          shared zod schemas (Issue/Epic/Story/Design)
├── core/             @on-par/factory-core       engine: router, phases, checkers
├── dashboard/        @on-par/factory-dashboard  (private) web dashboard, Vite + React
├── grade/            @on-par/factory-grade      (private) read-only grader for recorded runs
├── product/          @on-par/product            (private) proposer: brain-dump to engineering-ready issues
├── repo-context/     @on-par/repo-context       read-only repo reader port (zero deps)
├── scbench-adapter/  @on-par/scbench-adapter    (private) SlopCodeBench adapter
├── server/           @on-par/factory-server     (private) loopback SSE events + lane pause endpoint
└── tui/              @on-par/factory-tui        read-only Ink TUI for a live run
```

Packages marked (private) are not published to npm. For the dependency graph and per-package detail, see [docs/architecture.md](docs/architecture.md). To contribute, see [CONTRIBUTING.md](CONTRIBUTING.md) and the rules in [AGENTS.md](AGENTS.md).

## Quick start

**Prerequisites**

- Node.js ≥ 24 (the `engines.node` field in `packages/cli/package.json`)
- `git`
- One supported coding agent CLI (see [docs/agents.md](docs/agents.md)), on your PATH and signed in. Any one of them runs the whole loop (triage, PLAN, BUILD, CHECK and SHIP).
- The GitHub CLI `gh`, signed in with `gh auth login`. The factory uses `gh repo view` to detect your repo.
- A GitHub token. The factory reads `GITHUB_TOKEN`, then `GH_TOKEN`, and falls back to `gh auth token` when neither is set, so `gh auth login` is usually enough.
- Optional: `ollama` for experimental local models. When Ollama is not running, the factory skips local models and says so once in the log.

Two terms used in the steps below:

- **Constitution**: the written standard that defines "done right" for your repo. It lives in `.factory/constitution.md`, and every build is checked against it. See [Constitutions](#constitutions).
- **Triage**: the step where a model reads your open GitHub issues and proposes an ordered work queue in `.factory/state/queue.proposed`. You review the proposal and accept it with `factory triage accept`, and `factory run` then works through the accepted queue.

Run `factory doctor` after installing (Step 1) to check all of this.

### Use Codex

On Linux, install `firejail` first (for example `sudo apt install firejail`), before you set up an agent. It is the OS sandbox the factory wraps agent runs in. Without it, Codex still uses its own `--sandbox workspace-write` containment.

Install the Codex CLI and sign in once:

- `codex login` signs in with ChatGPT and uses your Plus or Pro plan, with no API key. Runs count toward your plan limits; manage them in ChatGPT settings.
- `codex login --with-api-key` uses API billing instead, which suits automation and CI.
- `codex login --device-auth` signs in on a headless machine.

`factory doctor` shows a `codex signed in` line with the sign-in method. Models whose CLI is not installed are skipped, so on a machine with only Codex every phase runs on Codex models and PLAN picks the codex build route. With both CLIs installed, pin a phase in `.factory/config.json` (`models.pins.plan`, `build`, `checker`, `triage`), set `route`, or reorder `tiers`; `factory triage --model <id>` picks the triage model for one run. See [docs/models.md](docs/models.md).

### Use Claude Code

Install the Claude Code CLI, for example `npm install -g @anthropic-ai/claude-code`, and sign in once:

- Run `claude` and complete `/login` to use your Claude subscription.
- Or set `ANTHROPIC_API_KEY` to use API billing instead, which suits automation and CI.

`factory doctor` shows a `claude installed` line with the CLI version and a `claude signed in` line. Run `factory doctor --probe-inference` to also send one real `claude -p` prompt. On a machine with only Claude Code, every phase runs on Claude models and PLAN picks the claude build route. For a minimal config and the other agents, see [docs/agents.md](docs/agents.md).

### Safety

To run unattended, the factory starts agent CLIs with their permission prompts turned off:

- Claude Code runs as `claude -p ... --permission-mode bypassPermissions` (the same mode as `--dangerously-skip-permissions`).
- Codex runs as `codex exec ... -c approval_policy=never` with `--sandbox workspace-write` by default. Tasks listed in `sandbox.codexFullAccessTasks` use `--sandbox danger-full-access` and are logged.

Each build runs in a separate git worktree (under `~/.factory/worktrees/<owner>/<repo>/` on a `factory/` branch; set `worktree.parent` to move it and `--branch-prefix` to change the prefix), never in your main checkout. Where available, agent runs are wrapped in an OS sandbox (`sandbox-exec` on macOS, `firejail` on Linux). `factory doctor` warns when no sandbox runtime is found. The agents still run as you, with your file permissions and your GitHub token, and builds run the target repo's tests and install its dependencies. Only point the factory at repos and issues you trust. Which hosts agents may reach, the registry hosts pre-allowed per ecosystem, and telemetry handling are in [docs/egress.md](docs/egress.md).

The factory never merges by default. `factory ship` and `factory run-issue` never merge; they stop at the PR, which is marked ready for review once CI passes. `factory run` and `factory supervise` merge only if you turn auto-merge on (`FACTORY_MERGE=1`, `run.merge.auto: true`, or `--auto-merge`). `FACTORY_MERGE_ADMIN=1` lets the token merge through unmet branch protection; set it only when you mean to. Full rules: [docs/config.example.yaml](docs/config.example.yaml).

To report a vulnerability, see [SECURITY.md](SECURITY.md).

**Step 1: Install**

```bash
npm install -g @on-par/factory-cli   # Requires Node.js 24 or newer
factory --version
factory doctor
```

On older Node versions, the CLI stops and tells you which version it needs. `factory doctor` checks git, your git identity (`user.name` and `user.email`, which commits need; set them with `git config --global`, or repo-local `git config` in the target repo works too), your coding agent CLI, `gh` auth, the GitHub token, npm and the sandbox, and prints a fix for anything missing. It works from any directory, including outside a repo. To run from a clone instead, see [CONTRIBUTING.md](CONTRIBUTING.md).

**Step 2: Point it at your repo**

```bash
cd /path/to/your/repo        # any git repo with a GitHub remote and open issues
factory init                 # creates .factory/ (config.yaml, constitution.md, .gitignore, state/)
```

`factory init` seeds `.factory/constitution.md` from the bundled `default-code` constitution and adds `.factory/` to `.git/info/exclude`. That keeps `.factory/` local to this clone. It isn't committed, so copy it yourself if you work from another machine or clone. Every run reads `.factory/constitution.md` from this main checkout, including builds that run in a lane worktree.

**Step 3 (optional): Pick a different constitution**

```bash
factory constitution --list                    # bundled constitutions and their checkers
factory constitution --checkers                # every built-in checker, one line each
```

For a code repo, skip this step. The `default-code` scaffold works as is. `--product` replaces the scaffold without `--force` while it is still untouched. Once you edit `.factory/constitution.md`, `--product` refuses, and only `--force` overwrites it.

**Step 4: Triage the backlog**

```bash
factory triage               # proposes .factory/state/queue.proposed from your open issues; review it, then:
factory triage accept        # validates the proposal and promotes it to .factory/state/queue
```

**Step 5: Ship your first issue**

```bash
factory ship 42              # PLAN → BUILD → CHECK → SHIP one issue (use an issue number from your repo)
```

While SHIP waits for CI, it logs progress. On a repo with no CI configured (no workflow files and no checks on recent default-branch commits), it skips the wait at once. Otherwise a PR with no checks reported yet counts as pending: SHIP and land keep waiting for the base branch's required checks, naming any still missing, until the 10 min CI timeout. When PLAN enriches an incomplete issue, it keeps your text and appends a `factory:enriched` section. Set `readiness.updateIssueBody: false` in `.factory/config.yaml` to keep enrichment out of the issue.

`factory ship` ends at a green, ready-for-review PR that closes the issue (it prints `✅ Issue #N → PR #M ready for review`). Merging stays with you: review the PR and merge it, or run `factory land <N>` to squash-merge and clean up the worktree. To process the whole triaged queue in parallel lanes instead, run `factory run` (after accepting a triage proposal with `factory triage accept`). `FACTORY_MERGE` and `FACTORY_MERGE_ADMIN` apply to `factory run`, `factory supervise` and `factory land` only; `factory ship` warns and ignores them.

## Configuration

`factory init` writes a minimal `.factory/config.yaml`:

```yaml
version: 2
```

Every other key is optional. [`docs/config.example.yaml`](docs/config.example.yaml) lists each key the factory reads, with its default and what it does. It is generated from the config schemas (`npm run config-example`) and a test fails when it drifts, so it matches the code. Copy only the keys you want to change (comments included) into `.factory/config.yaml`; `.factory/config.json` is still read for existing repos, and `factory migrate --to-yaml` converts it. `factory status --kpis` prints the effective config.

## Updating

```bash
npm install -g @on-par/factory-cli@latest
```

`factory self-update --check` reports whether a newer release is on npm. It works in 0.9.3 and later. Automatic updates are planned: the installer (#2355) and the daemon update loop (#1939). The planned design is in [docs/ops/updating.md](docs/ops/updating.md).

## CLI commands

The most-used commands, by the group `factory --help` lists them under. Run `factory --help` for the full, current list.

```bash
# Run work
factory ship <N>                    Plan → build → check one issue and open a ready-for-review PR; never merges
factory run-issue <N>               Like ship, but loads the issue first and exits 2 if it cannot be found
factory run-issue <N> --run-children Also run the child issues the size gate files when it splits <N>
factory run                         Claim queued issues and ship them, lanes in parallel; merges only when auto-merge is on
factory supervise [--now]           Unattended loop: wait for usage headroom, run the queue, repeat until it is empty
factory land <N>                    Squash-merge the issue's open PR once CI is green, then remove its worktree
factory stop / factory resume       Halt lanes after their current issue / clear the stop
factory stop|resume --json         One JSON object: action, repo, stopFlag {before, after}; idempotent

# Setup
factory init                        Set up .factory/ in this repo and check model reachability
factory doctor                      Check your environment (git, coding agent CLI, gh auth, GitHub token, npm, sandbox)
factory constitution --product <p>  Seed .factory/constitution.md from a bundled example constitution
factory constitution --checkers     List every built-in checker
factory models [--doctor]           List models with tiers, cost, and availability; --doctor probes provider CLIs

# Queue
factory triage [--product <p>]      Have a model propose a queue into .factory/state/queue.proposed
factory queue add <lane> <N...>     Queue GitHub issues into a lane (factory:queued labels)
factory check <N> [--json]          Read-only pre-flight: missing fields, and whether the size gate runs it as-is or would split it (alias: ready)

# Observe
factory status                      Show active runs, the GitHub queue, provider health, and recent events
factory status --json               One JSON object: STOP flag, provider breaker, active claims (--kpis ignored)
factory logs [--follow] [--json] [--issue <n>] [--limit <n>] [--since <cursor>]
                                    Print pipeline events (--limit/--since read only part of the log)
factory cost                        Show recorded model spend by model
factory usage                       Report 5-hour subscription usage
```

`factory check` exits 0 when the issue is ready and runs as-is, 1 when fields are missing, and 3 when it would split.

### `factory run-issue --run-children`

When the size gate decides an issue is too big, it files child issues and stops the run. Without the flag, `run-issue` exits 1, names the children, and suggests re-running with `--run-children`. With the flag, it runs those children itself:

- **Order.** Children run one at a time, in the build order the size gate filed them, under the same run lock as the parent.
- **Nested splits.** If a child is decomposed again, its new children replace it and run before the remaining siblings. No issue runs twice.
- **Closed children** are skipped.
- **Failures don't stop the run.** A child that fails or escalates is recorded, and the next child still runs.
- **`.factory/state/STOP`** is checked before each child starts. Once it is present, no further child starts, and the file is left in place (ADR-0111). A child already running finishes.
- **Summary.** At the end, `run-issue` prints one line per child: its PR, or why it failed, was skipped, or did not run.
- **No labels, no merge.** Like `ship`, it never touches the queue's `factory:*` labels and never merges. Each successful child ends at its own ready-for-review PR.

Exit codes: `0` when every child reached ready-for-review, was skipped as closed, or was replaced by its own children. `1` when any child failed or was not started because of STOP, or when the issue was decomposed and `--run-children` was not passed. `2` when the parent issue cannot be resolved, before any worktree or PR exists. If the issue is not decomposed, the flag changes nothing.

## Root npm scripts

| Script                                                            | What it does                                                                                                                                                                                                                                 | Runs in                                                                   |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `npm run test`                                                    | Vitest with coverage thresholds (the full-suite gate).                                                                                                                                                                                       | `verify.sh` (full path), CI                                               |
| `npm run test:integration`                                        | Pipeline integration suites.                                                                                                                                                                                                                 | Nightly workflow, on demand                                               |
| `npm run sim-monte-carlo -- [options]`                            | Headless simulator Monte Carlo runs: synthetic issues through fake PLAN→BUILD→CHECK→SHIP, no model or GitHub calls. Prints shipped/parked/escalated rates and exits 1 on a breached `--max-*-rate` threshold. `-- --help` lists the options. | On demand                                                                 |
| `npm run sandbox-ab-report -- [--costs <file>] [--events <file>]` | Docker-sandbox vs baseline A/B comparison over `.factory/state/costs.jsonl` and `.factory/state/events.ndjson` (defaults from `getFactoryPaths`), with a go/no-go recommendation (#656).                                                     | On demand                                                                 |
| `npm run mutation`                                                | Stryker mutation testing (`stryker.conf.json`).                                                                                                                                                                                              | On demand only. Not part of `scripts/verify.sh` and not run by CI (#805). |

The commit gate is `bash scripts/verify.sh` (see [.claude/skills/verify/SKILL.md](.claude/skills/verify/SKILL.md)).

## Model routing

Each task type maps to a tier of models in `packages/config/src/defaults.ts`. The router tries free local models first (experimental; see [docs/status.md](docs/status.md)), then cloud models, and fails over to the next model on rate limits, usage caps, timeouts, or errors. Effort levels can be set per model and task in `.factory/config.yaml`. Run `factory models --doctor` to see which models and provider CLIs are reachable. Tier order, effort settings, harnesses, and failover triggers are documented in [docs/models.md](docs/models.md). The adapter contract every harness implements (inputs, return value, failure reasons, per-phase expectations) is in [docs/harness-contract.md](docs/harness-contract.md).

## Constitutions

A constitution is a written standard that defines "done right" for a product. Every build round is tested against it. The source of truth for a real product is `.factory/constitution.md` in the **target repo**. `factory init` seeds the bundled `default-code` constitution. `factory init`, `factory constitution --init`, and `factory constitution --product <name>` all read from and write to that path, never to a file bundled with the factory itself.

The bundled files below are only templates and worked examples used to seed a new `.factory/constitution.md` (via `factory constitution --product <name>`). `factory constitution --checkers` lists the built-in checkers:

- `packages/config/src/constitutions/example-marketing-site.md`: Static site generation (brand, WCAG 2.2 AA, SEO, links)
- `packages/config/src/constitutions/example-data-app.md`: Data analysis (data integrity, report validation)
- `packages/config/src/constitutions/example-client-delivery.md`: Client delivery (client brand adherence, tech spec)
- `packages/config/src/constitutions/_template.md`: Template for new products

## Lane environment (parallel e2e)

Each lane leases a port from `.factory/state/ports.json` and every build/check command it runs (workers, `npm test`, lint, custom checkers) inherits:

| Variable              | Example                 |
| --------------------- | ----------------------- |
| `PORT`                | `3142`                  |
| `FACTORY_APP_PORT`    | `3142`                  |
| `FACTORY_BASE_URL`    | `http://127.0.0.1:3142` |
| `FACTORY_HEADLESS`    | `1`                     |
| `PLAYWRIGHT_HEADLESS` | `1`                     |

Product e2e suites should boot their app on `PORT` (strict-port) and point their test runner's base URL at `FACTORY_BASE_URL`. The constitution template scaffolds the full Playwright reference contract. When port leasing is disabled, checks still run but an `environment_warning` event flags the collision risk for app-testing worktrees. Factory-managed runs are headless by default, so e2e configs must honor `FACTORY_HEADLESS`. To run headed, set `FACTORY_HEADLESS=0` or run outside the factory. Unlike the port variables, `FACTORY_HEADLESS` and `PLAYWRIGHT_HEADLESS` are set even when no port lease is configured.

## Open-core boundary

**What's OSS (this repo):** `packages/cli`, `packages/core`, and `packages/config` are the open-source core. The full local pipeline (router, constitutions, checkers, phases) runs from this repo alone, MIT-licensed.

**What isn't published:** `packages/dashboard` (web dashboard, Vite + React walking skeleton), `packages/product` (the proposer: brain-dump to engineering-ready issues), `packages/server` and `packages/scbench-adapter` (SlopCodeBench adapter) live in this monorepo as private workspaces and are not published to npm. A hosted multi-tenant control plane is not part of this codebase. `packages/server` is a small local server. It serves `GET /events`, an SSE relay of the lane lifecycle bus, and `POST /repos/:owner/:repo/lanes/:laneId/pause`, which pauses a lane. Both are unauthenticated and loopback-only.

For the safety note (agent permissions, worktrees, and when the factory merges), see [Safety](#safety) under Quick start.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the verify gate, how to try one issue against a throwaway repo, and the factory-task issue template.

Security issues: see [SECURITY.md](SECURITY.md). Please report privately, not as a public issue.

## License

MIT, On PAR Dev
