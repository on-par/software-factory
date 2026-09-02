// packages/scbench-adapter/src/workspace-constitution.ts — factory-authored standards for SCBench workspaces (#1184).

/** Generic engineering standards written into every SCBench workspace's
 *  .factory/constitution.md by prepareWorkspace, so the nested factory
 *  run injects them into PLAN/BUILD/CHECK exactly as a real repo's
 *  committed constitution would be. Content must stay generic: never a
 *  hidden test name, quoted assertion, or per-problem hint (see the
 *  ADR shipped with #1184). */
export const WORKSPACE_CONSTITUTION = `---
product: scbench-workspace
version: 1
---

# Engineering standards for this workspace

These standards apply to every program built in this workspace, in
addition to the task specification. Production-quality behavior is
expected even where the specification does not restate it. Where the
specification defines exact output, exit codes, or formats, the
specification wins.

## Process lifecycle

- Any long-running mode (watch, serve, poll, follow, or any loop that
  runs until interrupted) MUST shut down promptly and cleanly on SIGINT
  and SIGTERM: the process exits within a second or two of the signal,
  without a traceback on stderr. Install signal handlers if the runtime's
  default behavior would hang or crash.
- Background threads must never keep the process alive after the main
  loop stops: mark them as daemon threads or join them with a bounded
  timeout during shutdown.
- Sleeps and blocking network waits inside loops must be interruptible;
  a shutdown request must not wait out a full poll interval.
- Flush stdout before exiting so already-emitted lines are never lost.

## CLI behavior

- Errors go to stderr; only specified output goes to stdout.
- Exit codes follow the specification exactly; a clean shutdown after an
  interrupt is not an error.
- Fail with a clear message on invalid input, never an unhandled stack
  trace.
`;
