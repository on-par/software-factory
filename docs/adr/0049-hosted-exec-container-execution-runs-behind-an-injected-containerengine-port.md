# ADR-0049: Hosted-exec container execution runs behind an injected ContainerEngine port

- Status: Accepted
- Date: 2026-08-26

## Context

Issue #899 makes Docker the real job boundary for hosted execution, but CI
runs with no docker daemon and the repo's hosted/harness/router code is
uniformly built on injected effect seams (HostedClock for time, ExecFn for
shelling commands). Executing a leased job also has two audit obligations
the earlier in-memory slices did not: the container must always be
destroyed (even after a crashed run) and the control plane must receive
proof that it was. A direct child_process/docker + node:fs call inside the
runner would be untestable without Docker, break the clock/exec-injection
convention, and hard-wire the runtime to one container CLI. It would also
leave no natural place to represent cleanup proof, since complete/fail
release the lease and freeze the result before the container is removed.

## Decision

Abstract all Docker and workspace-fs effects behind a ContainerEngine port
(prepareWorkspace / run / remove) defined alongside the runContainerJob
orchestrator in core's hosted module. The real adapter, createDockerEngine,
implements the port by shelling `docker run` / `docker rm -f` / `docker ps`
through the existing ExecFn seam (defaulting to defaultExecFn) — no new
dependency, no `docker run --rm`. Containers are named deterministically
from the job id so cleanup can force-remove by name even after a partial
run, removal always runs in a finally, and cleanup proof is recorded as a
new additive 'cleaned' hosted-job event via a lease-free store.recordCleanup
rather than as a field on the frozen HostedJobResult.

## Consequences

Positive: the orchestrator and store stay fully hermetic and unit-testable
with a fake engine; CI never needs Docker; a future runtime (podman,
remote executor) swaps in by implementing the same port; cleanup is
guaranteed and independently auditable. Negative: the real docker adapter's
correctness is proven only by asserting the command strings it builds (via
a fake ExecFn), not by an end-to-end container run in CI — a real
integration run remains a later, out-of-CI concern; and cleanup proof
lives in the event stream, so consumers must read events, not the result,
to confirm it.

## References

- [Issue](https://github.com/on-par/software-factory/issues/899)
- [ADR-0002 — structured logging via the event log (additive event kinds)](docs/adr/0002-structured-logging-via-event-log.md)
