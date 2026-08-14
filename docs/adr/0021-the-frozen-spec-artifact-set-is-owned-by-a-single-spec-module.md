# ADR-0021: The frozen spec artifact set is owned by a single spec module

- Status: Accepted
- Date: 2026-08-14

## Context

The PLAN phase's frozen spec — `.factory/plans/issue-N.md` plus the
design JSON/MD and ADR-drafts sidecars — is the contract every later phase
and several tools consume. Its layout and parsing rules were duplicated
across six files in four directories: raw gray-matter frontmatter parsing,
route normalization (`.trim()` + validate), sidecar path derivation
(design/index.ts's `designArtifactPaths` and adr/write.ts's `adrDraftsPath`,
the latter literally comment-marked "Mirrors designArtifactPaths"), and the
archive rule in plan.ts's `archiveExistingSpec`. Adding a fifth artifact or
renaming a sidecar therefore required touching all six files, and missing
one site produced silent drift instead of an error. The route-resolution
work (#664) needs a single post-freeze route-mutation seam
(`updateSpecRoute`) to build on.

## Decision

A new `packages/core/src/spec/` module owns the entire frozen-spec artifact
set. `specPaths(specPath)` derives all four file paths; `parseSpec(content)`
is the one and only route-normalization site (with `readSpec` as its
file-reading wrapper); `writeSpec` is the only writer of the four files
(writing pre-rendered sidecar content so rendering stays in `design`);
`archiveSpec` owns the archive rule for all four files; `updateSpecRoute`
mutates the frozen route post-freeze. All six former consumers route
through the module, and the duplicated path helpers are deleted.

## Consequences

Positive: renaming a sidecar or adding a fifth artifact is now a one-module
change; route normalization cannot drift between PLAN and eval; archiving
is uniform across the set (orphan sidecars are archived too); #664 gets a
single seam to mutate the frozen route. Negative: any new writer of the
artifact set must route through writeSpec rather than writing files
directly, and content-only consumers must call parseSpec (the pure twin of
readSpec) — a convention the module's tests and ADR pin down.

## References

- [Issue #666](https://github.com/on-par/software-factory/issues/666)
