# ADR-0050: The hosted job workspace is always a fresh disposable clone, never the host checkout

- Status: Accepted
- Date: 2026-08-26

## Context

#900 moves hosted execution from fake no-op containers to real repo-shaped
execution, but its core safety property (echoed in the acceptance criteria
and out-of-scope list) is that the container must act on a fresh checkout
of the job's repo and must never mount or mutate the host checkout.
ADR-0049 already put all Docker/workspace-fs effects behind the injected
ContainerEngine port; the open question this issue forces is _where_ the
clone happens and _how_ a clone failure propagates. A throw from deep in
the engine would bypass the store's failure accounting and the guaranteed
cleanup; minting auth to clone private repos is out of scope for the MVP.

## Decision

prepareWorkspace owns materializing the workspace: it creates a disposable
temp dir and git-clones job.request.repoSlug into a repo/ subdir of that
dir, returning the result as a data-shaped CloneOutcome ({ ok, commit?,
error? }) rather than throwing. runContainerJob treats clone.ok === false
as a clean job failure (store.fail with a "repo clone failed:" reason) and
skips the container run, while cleanup of the whole workspace still runs
in finally. The docker adapter clones over unauthenticated https built by
an injectable cloneUrlFor (default https://github.com/<repoSlug>.git) and
records the resolved commit as workspace identity. The host checkout is
never a mount source.

## Consequences

Positive: the fresh-clone invariant is enforced in one place; clone
failure is audited through the same store.fail + cleanup path as
exit-code/timeout failures; cloneUrlFor is the single seam a future
GitHub-App-token story injects into; the cloned commit gives every run a
recorded workspace identity. Negative: the MVP can only clone public repos
until auth lands, and prepareWorkspace now performs network I/O, so the
real adapter's clone correctness is proven in CI only by asserting the git
command strings (via a fake ExecFn), with a real clone remaining an
out-of-CI integration concern (consistent with ADR-0049).

## References

- [Issue #900](https://github.com/on-par/software-factory/issues/900)
- [ADR-0049 — container execution behind an injected ContainerEngine port](docs/adr/0049-hosted-exec-container-execution-runs-behind-an-injected-containerengine-port.md)
