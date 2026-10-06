# ADR-0136: BUILD is commit-only on every route by default, and only `build.publishFromBuild` lets the claude route push and open a PR before CHECK

- Status: Accepted
- Date: 2026-10-02

## Context

The claude BUILD prompt told the worker to push, open a PR, wait for green CI and mark it ready before CHECK ran. So on the default route (and any run with a pinned Claude build model, ADR-0092) a PR could exist, and get reviewed or merged, before the factory's own checkers passed. The codex and opencode routes and local-only runs were already commit-only, with SHIP pushing and opening the PR after CHECK. Having two publishing models made the PR lifecycle depend on which harness happened to build, including after a codex→claude failover.

## Decision

`buildPhase` (packages/core/src/phases/build.ts) sends `buildCommitOnlyPrompt` on the claude route and on the codex→claude failover unless `publishFromBuild` is true and `disablePublish` (local-only) is false. `publishFromBuild` comes from `build.publishFromBuild` in the factory config, default false (packages/config/src/defaults.ts), resolved by `resolveBuildPublish`, with `FACTORY_BUILD_PUBLISH=1/0` overriding it. By default only SHIP pushes the branch and opens the PR, after CHECK passes.

## Consequences

Every route has the same PR lifecycle by default: no PR exists for a branch until SHIP. CHECK always runs before anything is published. The claude worker no longer waits on GitHub CI inside BUILD. A repo that depends on the old behavior must set `build.publishFromBuild: true`. Future BUILD prompt builders must not add push/PR instructions outside that opt-in.

References: issue #1867, parent issue #1796.
