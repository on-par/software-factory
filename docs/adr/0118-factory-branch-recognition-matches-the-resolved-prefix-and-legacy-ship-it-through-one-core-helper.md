# ADR-0118: Factory branch recognition matches the resolved prefix and legacy ship-it through one core helper

- Status: Accepted
- Date: 2026-10-01

## Context

#1714 changed the default factory branch prefix from `ship-it` to `factory`, and #1715 let branch-creating commands override it with `--branch-prefix`. Repositories still have open `ship-it/<n>-…` PRs, branches and worktrees from before the rename, and migrating them is out of scope. The code paths that recognize existing factory branches (land, resume-approved, worktree gc, human-review KPIs, auto-ingest dedupe) each had their own hardcoded or single-prefix regex. After the rename each would have silently dropped either the legacy or the new lanes.

## Decision

Every code path that recognizes an existing factory branch matches it through `factoryBranchPrefixes` / `factoryBranchIssue` in `packages/core/src/utils/index.ts`. Those helpers accept `<resolved prefix>/<n>-…` and `<LEGACY_BRANCH_PREFIX>/<n>-…`, where `LEGACY_BRANCH_PREFIX = 'ship-it'`. The resolved prefix comes from the command's `--branch-prefix` flag, defaulting to `resolveBranchPrefix()`. Branch creation still uses only the resolved prefix. New recognition code must use these helpers and must not add its own prefix regex.

## Consequences

Legacy lanes keep landing, resuming, counting in KPIs, being reaped by worktree gc, and deduping ingest without any migration. Dropping legacy support later means removing one constant and its use in `factoryBranchPrefixes`. A non-factory branch named `ship-it/<digits>-…` is now treated as a factory lane by every recognizer. Core's single-prefix `issueFromFactoryBranch` stays as a public primitive, so two matchers coexist until a later cleanup.
