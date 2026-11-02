# ADR-0172: Remove the unused ProjectV2 board queue

- Status: Accepted
- Date: 2026-11-01

## Context

The ProjectV2 board queue stack has no production caller: no shipped command or daemon path
constructed its poller, reader, status writer, dispatcher, scheduler, or reprioritization audit.
Queue intent is carried on issue labels under ADR-0045.

## Decision

Remove the ProjectV2 board poller, reader, status writer, board-queue dispatcher and scheduler,
and reprioritization audit. Queue intent remains on issue labels as specified by ADR-0045.

ADR-0067's principle that execution state and phase-level events stay local-only remains in
force. Retire its board boundary test with the board-writing code it exercised.

## Consequences

The unused board queue implementation and its tests no longer need maintenance. Any future
board integration must preserve the local-only execution-state and phase-event principle.
