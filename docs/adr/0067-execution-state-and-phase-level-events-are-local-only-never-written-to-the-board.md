# ADR-0067: Execution state and phase-level events are local-only, never written to the board

- Status: Accepted
- Date: 2026-08-30

## Context

The daemon has GitHub ProjectV2 board write access purely to publish a coarse status projection
(active / done) for queued issues (#849, #868). That same credential could, with one careless
edit, start pushing fine-grained execution detail to the board: any `LaneLifecycleEvent` field
beyond the coarse status — `phase`, `status`, `detail`, `worktreePath`, `laneId`, `ts`, `issueId`
— or a reference to a local execution artifact. The authoritative home for execution state is the
local state root `~/.factory/<owner>/<name>/` (`getFactoryPaths`): `events.ndjson`, `costs.jsonl`,
the merge/git/run/ports lock files, and `breaker.json` all live there and must not leak into any
board mutation payload. Nothing currently enforces this direction of the boundary, so the erosion
would be silent. The existing single ad-hoc marker test is insufficient: it has no exact-key
allowlist, does not name an offending field, and says nothing about local execution artifacts.

## Decision

The board-writing code path (`createProjectBoardStatusWriter` -> its injected `graphql`) may
touch only an allowlisted set of fields: the mutation variables are exactly `{ projectId, itemId,
fieldId, value }` and `value` is exactly `{ singleSelectOptionId }`. No phase-level lifecycle
field and no reference to a local execution artifact may appear in a board mutation payload.
Execution state — `events.ndjson`, cost history, lock files, and breaker state — is authoritative
only under the local state root `~/.factory/<repo>/` and is never mirrored to the board.
`packages/core/src/queue/project-board-boundary.test.ts` enforces all three claims (exact-key
allowlist, per-field phase-level absence with the offending field named, and local-artifact
locality + payload absence) and fails closed on any drift.

## Consequences

Positive: the board stays a coarse projection; any future attempt to widen the board write
surface fails a required check that names exactly what leaked, and the boundary is documented
where PLAN phases will see it. Negative: adding a legitimately new coarse board field requires
updating the allowlist constant and this ADR in the same PR — deliberate friction that keeps the
widening explicit rather than accidental.

## References

- Issue: https://github.com/on-par/software-factory/issues/1050
- `getFactoryPaths` — the local state root layout: https://github.com/on-par/software-factory/blob/main/packages/core/src/config/index.ts
