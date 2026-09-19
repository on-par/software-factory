# ADR-0112: A disposable-docker lane workspace is cloned to a host temp dir, then `docker cp`'d in — not `docker exec` or a bind mount

- Status: Accepted
- Date: 2026-09-19

## Context

#1535 gave every `workspace.backend: disposable-docker` lane a managed,
labeled container, created but not started. #1536 needed that container's
code to come from a fresh clone of the remote repo — never from the host's
sibling worktree — so a lane can never read or write host git state, and the
host's `git worktree list` stays byte-identical across a lane's lifetime.

Three ways to get a clone into the container were considered:

1. **`docker exec git clone ...` inside the container.** Rejected: the
   container `createLaneContainer` makes is created but not started (#1535's
   explicit scope boundary — starting it belongs to the exec-routing story).
   `docker exec` requires a running container, so this would force starting
   it earlier than any other lane-lifecycle code expects.
2. **A bind mount of a fresh host clone.** Rejected: a bind-mounted directory
   needs an owner responsible for creating and later deleting it outside the
   container's own lifecycle, and this issue is explicitly scoped to
   `prepareWorkspace` only — teardown ownership is out of scope here and
   belongs with the container-teardown story (#1527).
3. **Host `git clone --depth 1` into an ephemeral temp dir, `docker cp` into
   the container, then delete the temp dir.** Chosen: works against a
   created-but-not-started container, needs no bind mount or extra teardown
   owner (the temp dir is deleted synchronously in the same call), and
   mirrors the already-tested `ContainerEngine.prepareWorkspace` clone
   pattern used by the hosted-exec path.

## Decision

`ContainerEngine.prepareLaneWorkspace(containerName, repoSlug)` clones
`repoSlug` fresh from its remote URL into a temp dir under the host's temp
root, `docker cp`'s that directory's contents into the container at
`containerRepoPath` (`/workspace/repo`), then removes the temp dir — in the
success path and every failure path. A clone or copy failure is returned as
data (`{ ok: false, error }`), never thrown, matching the existing
`CloneOutcome` contract. Nothing under this call touches the host's actual
worktree list: the clone happens in mkdtemp'd scratch space, and cleanup is
guaranteed by the same function, not deferred to a later teardown pass.

## Consequences

Positive: the lane container's code provably never derives from host state —
provable by a `git worktree list` diff around the call — and cleanup can't be
skipped by a later phase forgetting to run it, since the temp dir's lifetime
is fully contained in `prepareLaneWorkspace`.

Negative: every lane workspace prep pays a full `git clone --depth 1` over
the network rather than reusing a warm host clone; acceptable for now given
the small, single-purpose scope of this issue, but worth revisiting if lane
startup latency becomes a bottleneck.

## References

- Issue #1536: Clone repo fresh from remote into the disposable container
  workspace
  https://github.com/on-par/software-factory/issues/1536
- Issue #1535 (container creation this builds on)
- Issue #1527 (container teardown — out of scope here)
