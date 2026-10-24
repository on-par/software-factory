# Per-lane agent memory

An optional, committed file that PLAN always sees for runs on one queue lane. Use it for durable,
lane-specific guidance (recurring pitfalls, areas to avoid) that would otherwise bloat the shared
constitution or be restated on every issue. "Lane" is the queue lane (`factory:lane:<name>`, see
[CONTEXT.md](../CONTEXT.md)).

## File

`.factory/agent-memory/<lane-slug>.md`, where `<lane-slug>` is the same slug as the `factory:lane:<slug>`
label (lowercase `[a-z0-9-]`).

- Absent file: PLAN's prompt is unchanged. The feature is opt-in.
- Size cap: 4096 bytes. An oversized (or unreadable) file is ignored, PLAN logs an
  `agent_memory_oversized` warning event, and `factory doctor` shows an optional warning row.
- Only PLAN reads it, and only for runs on that lane. One lane's file never reaches another lane's prompt.
  Runs with no lane (a one-off `run-issue`) read no memory.
- The content is injected as untrusted data: context, not instructions that override the PLAN steps.
- `.factory/` must be committed (see the `.factory in git` doctor row) so worktrees see the file.

## Updating it

**Updates ship only through a pull request**, opened by the factory as an ordinary issue run or by a
human. A run never writes or rewrites the memory file on `main` or in its worktree outside a reviewed
pull request diff.

This is distinct from `factory learn` pitfall entries (#1901), which are unrelated to this file.
