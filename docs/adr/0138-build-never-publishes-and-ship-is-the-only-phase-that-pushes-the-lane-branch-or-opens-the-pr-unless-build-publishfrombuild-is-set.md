# ADR-0138: BUILD never publishes, and SHIP is the only phase that pushes the lane branch or opens the PR, unless build.publishFromBuild is set

- Status: Accepted
- Date: 2026-10-02

## Context

Before #1867 the claude BUILD route pushed, opened a PR and waited for CI before CHECK ran, while the codex
and opencode routes only committed. So whether a PR existed before the factory's own checkers passed
depended on which harness built the change. ADR-0136 made BUILD commit-only by default on every route,
including the codex→claude failover. It recorded that as a prompt-selection rule in buildPhase, not as a
boundary between phases. Route descriptions in packages/config/src/defaults.ts (build_claude "drives its own
commits") could still be read as meaning the route publishes. Without a phase-level rule, a future
prompt builder, route or harness could start pushing again from BUILD without anyone noticing.

## Decision

BUILD never publishes. No BUILD route (claude, codex, opencode, or a failover between them) and no BUILD
prompt builder may push the lane branch, open or update a pull request, or wait on GitHub CI. BUILD's output
is local commits in the lane worktree. SHIP is the only phase that publishes. It pushes the branch and
opens the PR, and only after CHECK passes. Its force-push rules are in ADR-0137. The only exception is the
explicit opt-in in ADR-0136: `build.publishFromBuild: true` (or FACTORY_BUILD_PUBLISH=1) lets the claude
route send the publishing prompt, and local-only runs ignore it. Route descriptions in
packages/config/src/defaults.ts describe what a BUILD route commits and must not say that it publishes.

## Consequences

With the default config, no PR exists for a lane branch until CHECK has passed. Every route has the same
PR lifecycle, and reviewers never see unchecked work. A new BUILD route or prompt builder that pushes, opens
a PR or polls CI breaks this ADR unless it is gated behind `build.publishFromBuild`. BUILD cannot use GitHub
CI as a feedback loop. It relies on local verification and on CHECK. If the publishFromBuild opt-in is
removed later, this ADR loses its one exception and ADR-0136 should be superseded.

## References

- [ADR-0136 (BUILD commit-only by default, publishFromBuild opt-in)](docs/adr/0136-build-is-commit-only-on-every-route-by-default-and-only-build-publishfrombuild-lets-the-claude-route-push-and-open-a-pr-before-check.md)
- [ADR-0137 (SHIP lease-pinned force push)](docs/adr/0137-ship-force-pushes-a-lane-branch-only-under-a-lease-pinned-to-the-remote-sha-recorded-at-worktree-creation.md)
- [Issue](https://github.com/on-par/software-factory/issues/1870)
