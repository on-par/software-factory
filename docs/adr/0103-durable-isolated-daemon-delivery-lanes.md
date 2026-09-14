# ADR-0103: Durable isolated daemon delivery lanes

- Status: Accepted
- Date: 2026-09-14

## Context

The explicit-run HTTP API needs durable cancellation, process supervision,
immutable execution configuration, and actual concurrent execution. Concurrent
CLI processes must not mutate the same checkout or share their run state.

## Decision

The CLI installs the durable run runtime and supervised ship executor in factoryd.
The runtime persists run identity, frozen settings, lane, logs and execution state
in `runs.json` beside the registry. Existing per-file explicit run records remain
readable and fence duplicate submission. Legacy requests without a lane occupy
lane 1 and retain sequential execution.

An optional integer lane ID (1–8) enables per-lane FIFO execution. A runtime must
explicitly enable parallel support with an executor that isolates lane requests.
The production ship executor creates a worktree under the Git common directory's
`factory-runs/<runId>` and a unique `codex/run-<runId>` branch. Its CLI pipeline
uses the same run-specific branch prefix, so nested pipeline worktrees and retry
branches cannot collide. Run state stays local to that isolated checkout. Daemon
children share a port lease registry, including its existing lock, across lanes.

`GET /capabilities` advertises `run.execution-config.v1`, and advertises
`run.isolated-lanes.v1` only when parallel execution is enabled. Clients must gate
lane commands on that capability. Each accepted execution configuration is
validated and retained as part of request identity. The subprocess receives that
validated snapshot via `FACTORY_RUN_CONFIG_JSON`, a transport across the process
boundary rather than an operator policy override. Existing model and runtime
loaders read the snapshot instead of mutable checkout configuration and validate
it normally; contradictory inherited model settings cannot replace it.

Cancellation aborts only the selected lane and waits for its process group.
Supervised detached commands retain process ownership until cleanup, and parent
watchdogs terminate orphaned descendants. Restart marks unfinished runs
interrupted; existing IDs are never executed again implicitly. Live orphan
processes fence new execution until they stop. Storage errors stop dispatch.

## Consequences

Different lanes can execute concurrently, while default callers remain sequential.
Repository attachment is still required, and repository detachment drains active
runtime work. Worktrees are retained for inspection rather than removed on
failure or cancellation. Automatic scheduling, retrying interrupted execution,
and garbage collection remain separate work.
