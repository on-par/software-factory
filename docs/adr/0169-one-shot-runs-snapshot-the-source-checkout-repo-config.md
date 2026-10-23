# ADR-0169: One-shot runs snapshot the source checkout's repo config for the whole run

- Status: Accepted
- Date: 2026-10-23
- Issue: #3600

## Context

A run reads its repo config (`.factory/config.yaml|yml|json`) in two places. The CLI loads model pins,
policy and the constitution from the source checkout. CHECK resolves the declared `checks`
(`checks.build`, `checks.test`, `checks.lint`), `qa` and evidence commands from the worktree. The
worktree is checked out from git, so when a repo keeps `.factory/` untracked (in `.gitignore` or
`.git/info/exclude`), the worktree has no config. CHECK then skipped compile, tests and lint, and the
run shipped with nothing built or tested.

The daemon already avoids this split. `ship-executor` passes one immutable snapshot to the child
process in `FACTORY_RUN_CONFIG_JSON`, and `loadRepoConfig` and `loadFactoryConfigForRepo` read that
snapshot instead of any file.

## Decision

Every one-shot entry point uses the same channel. `shipIssue` (the CLI path for `ship`, `run-issue`,
`run-brief`, `run` lanes, `run-issue --run-children` and `resume --from check`) calls
`holdRunConfigSnapshot(paths.config)` before it loads any config. The helper reads the source
checkout's config file with the existing reader. It writes the parsed object to
`FACTORY_RUN_CONFIG_JSON` and the file path to `FACTORY_RUN_CONFIG_ORIGIN`. Then every loader in
the run, the worktree CHECK resolvers included, sees one config source.

- A snapshot that is already set (the daemon's) wins. The helper does not change it.
- With no config file in the source checkout, the helper sets nothing. The loaders then behave as
  they did before.
- The helper returns a release function. The snapshot is cleared when the last concurrent holder
  releases it, because the lanes of one `factory run` process share it.
- Verification subprocesses still drop both variables (`VERIFICATION_SCRUBBED_ENV_VARS`).

We use the environment and not `CheckerContext.checks` because the environment is the established
channel. The worktree-reading consumers (the build/test/lint resolvers, the BUILD lint prompt,
the flaky re-run, `app_smoke`'s `qa` and the evidence allowlist) read through `loadRepoConfig`. Threading
an explicit value to each of them would create a second source that could drift.

## Consequences

When the source checkout has a config file, a one-shot run uses that file, not the copy committed
on the base branch. This matches the model pins, which already came from the source checkout. SKIP
details now name the probed file and directory: the worktree file (and the other file names it
tried), or the run config snapshot and its origin. `factory doctor` warns when the config is
git-ignored, because other checkouts and CI cannot see it.
