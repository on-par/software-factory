# ADR-0150: Lane worktrees resolve from `worktree.parent` with owner/repo namespacing for shared roots and a fixed `<repo>-factory-` basename

- Status: Accepted
- Date: 2026-10-01

## Context

Lane worktrees were always siblings of the checkout. The CLI hard-coded that path and the `worktree.parent` setting was never read. Siblings clutter the user's repos directory and look like real checkouts. A shared home-directory root needs a per-repo namespace because many repos (and many owners with the same repo name) share it. An in-repo root is tidy, but target repos' own tooling crawls nested checkouts. GC (`sweepWorktrees`) recognises factory worktrees from `git worktree list` by the `<repoBase>-factory-` basename, not by location, and must keep reaping worktrees created under the old layout.

## Decision

`worktree.parent` defaults to `~/.factory/worktrees`. Lane worktree paths are resolved only by `resolveWorktreeRoot` / `laneWorktreePath` in `packages/core/src/utils/worktree-location.ts`. A parent that starts with `~` or is absolute is a shared root and gets `<owner>/<repo>` appended. A repo-relative parent (including `../` and the opt-in `.factory/worktrees`) resolves against the repo root with no namespacing. The lane basename stays `<repoBase>-factory-<prefixSlug>-<issue>` whatever the root, so GC keeps matching by basename and does not depend on config. When the configured path does not exist and a legacy sibling worktree does, the legacy path is used; existing worktrees are never moved. A parent inside the repo is added to the repo's `info/exclude` before a worktree is created there.

## Consequences

New worktrees no longer clutter the repos directory and are easy to find in bulk. GC needs no change and reaps old and new layouts alike. Under the shared root the basename repeats the repo name, which is redundant but deliberate. New code that computes a lane worktree path must call `laneWorktreePath`. A repo that wants the old layout sets `worktree.parent: "../"`. The in-repo opt-in carries the risk that the target repo's tooling may scan nested checkouts.

References: ADR-0103, ADR-0112, ADR-0118, ADR-0149; [issue #1758](https://github.com/on-par/software-factory/issues/1758).
