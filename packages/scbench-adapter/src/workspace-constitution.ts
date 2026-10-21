// packages/scbench-adapter/src/workspace-constitution.ts — factory-authored standards for SCBench workspaces (#1184, v2 #1204).

/** Generic engineering standards written into every SCBench workspace's
 *  .factory/constitution.md by prepareWorkspace, so the nested factory
 *  run injects them into PLAN/BUILD/CHECK exactly as a real repo's
 *  committed constitution would be. Content must stay generic: never a
 *  hidden test name, quoted assertion, or per-problem hint (see
 *  ADR-0078). v2 (#1204) adds cross-checkpoint stability, spec-exact I/O,
 *  minimal-surface and verification standards. */
export const WORKSPACE_CONSTITUTION = `---
product: scbench-workspace
version: 2
---

# Engineering standards for this workspace

These standards apply to every program built in this workspace, in
addition to the task specification. The work arrives in increments
(checkpoints); each one extends the same program. Where the
specification defines exact output, exit codes, or formats, the
specification wins.

## Process lifecycle

- Any long-running mode (watch, serve, poll, follow, or any loop that
  runs until interrupted) MUST shut down promptly and cleanly on SIGINT
  and SIGTERM: exit within a second or two, without a traceback on
  stderr. Install signal handlers if the default would hang or crash.
- Background threads must never keep the process alive after the main
  loop stops: make them daemon threads or join them with a timeout.
- Sleeps and blocking waits inside loops must be interruptible.
- Flush stdout before exiting so already-emitted lines are never lost.

## CLI behavior

- Errors go to stderr; only specified output goes to stdout.
- Exit codes follow the specification exactly; a clean shutdown after an
  interrupt is not an error.
- Fail with a clear message on invalid input, never an unhandled stack
  trace.

## Cross-checkpoint stability

- Behavior and outputs from earlier increments keep working unless the
  current specification explicitly changes them.
- Run the existing test suite before and after every change; a test
  that passed before must still pass after.
- Never remove or rename a documented flag, subcommand, output field,
  or exit code. Extend formats; do not reshape them.

## Spec-exact I/O

- Every example in the specification must reproduce byte-exactly:
  same text, field order, whitespace, trailing newline, and exit code.
  Turn each example into a test.
- Every error path the specification names gets a test that checks the
  message, its target stream (stdout or stderr), and the exit code.
- Do not add output the specification does not ask for.

## Minimal surface

- No speculative abstractions, duplicated helpers, or dead code.
- No new dependencies the specification does not require.
- Prefer editing the existing module over adding new files.

## Verification

- Factory-authored tests for this workspace live under .factory/tests/,
  per ADR-0081.
- For Python workspaces, run the suite with:
  python3 -m pytest .factory/tests
- Run it before and after each change, and finish with it green.
`;
