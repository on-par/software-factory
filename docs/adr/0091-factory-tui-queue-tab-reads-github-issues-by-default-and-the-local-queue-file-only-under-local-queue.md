# ADR-0091: `factory tui`'s Queue tab reads GitHub Issues by default and the local queue file only under `--local-queue`

- Status: Accepted
- Date: 2026-09-10

## Context

`factory run` and `factory supervise` claim work from GitHub Issues by
default and read `.factory/state/queue` only under `--local-queue`
(#824). `factory status` followed in ADR-0087: its `== Queue ==` band is
the claimable GitHub-backed backlog. `factory tui` was the last surface
still wired to the local file only — `cmdTui` passed `queueFile` /
`queueProposedFile` into `@on-par/factory-tui`, whose Queue tab polled
`readQueue()` every two seconds. On a checkout with a stale queue file the
tab listed dozens of old lines while the factory was actually claiming from
GitHub, so an operator watching the TUI could not tell what was really
claimable (#1362; the Mini 2026-09-09 scenario in #1339).

The TUI package deliberately depends only on `@on-par/factory-core`, `ink`
and `react` — it has never imported octokit — and ADR-0067 fixes the
direction of GitHub traffic: intent (what is queued, who claimed it) may be
read from labels, but execution state and phase events stay local and are
never written to the board.

## Decision

1. **Same flag, same default as `factory run`.** `factory tui` gains
   `--local-queue` with `run`'s exact help text. Without it the Queue tab
   lists claimable GitHub-backed work; with it the tab reads the local
   queue file exactly as before.
2. **One read of `factory:queued`, grouped and ordered like `list()`.**
   `readGithubQueueSnapshot` (core, `queue/github-queue.ts`) issues a single
   `listOpenIssuesWithLabels` call for `factory:queued`, derives lanes from
   `factory:lane:*` labels (as `GithubQueue.lanes()` does), orders each lane
   with the same `orderedCandidates` that `list()`/`claimNext()` use, and
   maps `factory:in-progress` / `factory:claimed-by:*` / `factory:parked`
   onto a per-entry `status` and `claimant`. It throws on the same
   malformed-order-label states `list()` throws on. This is claimable-only
   by construction, matching ADR-0087's `== Queue ==` band.
3. **The TUI takes a reader, not a file path.** `RunTuiOptions.queueFile` /
   `queueProposedFile` are replaced by a `QueueReader` — `{ source, read,
pollMs? }` — and `AppProps.readQueueFn` is folded into it. The CLI builds
   the reader (`tuiQueueReader`): octokit is constructed lazily, once, and
   only on the GitHub path, so `@on-par/factory-tui` still never depends on
   octokit and `--local-queue` never builds a client (the same laziness
   `planRunLanes` promises).
4. **Widened `QueueSnapshot`, additive only.** `QueueSnapshotEntry` gains
   optional `title`, `status` (`queued | in-progress | parked`) and
   `claimant`; `QueueSnapshot` gains optional `error`. `readQueue()` for
   the local file is unchanged and sets none of them. The Queue tab lets a
   live lane from the event log win over the snapshot's label-derived
   status and title, so what is running is never described by a label.
5. **Degrade, never fail to start.** No detected repo or no GitHub token
   becomes a snapshot `error` the tab renders with `factory status`'s
   wording (`no GitHub token — run \`gh auth login\``). A thrown read is
rendered as `queue lookup failed — <reason>` and the previous entries
are kept. The tab heading names the source (`queue: GitHub`/`queue:
   local file`). GitHub is polled every 30 s, not every 2 s.

## Consequences

- The TUI and `factory status` now agree on what "Queue" means, and the
  Active tab stays event-log-driven, so ADR-0067's boundary is untouched.
- `QueueIssue.title` is now populated by `createOctokitQueueClient`; it is
  optional, so existing fakes keep compiling.
- `RunTuiOptions.queueFile` / `queueProposedFile` and
  `AppProps.readQueueFn` are gone. `@on-par/factory-tui` has one queue seam
  (`queueReader`), which is also the test seam.
- A GitHub-backed reader shows `in-progress` only for the transient window
  where an issue carries both `factory:queued` and `factory:in-progress`
  (mid-claim); a fully claimed issue leaves the Queue tab and appears in
  Active once its phase snapshot exists — the same split ADR-0087 describes.
- The 30 s GitHub poll and error retention are deliberately simple; a
  richer per-entry state (e.g. "queued but its claimant is dead") remains
  the follow-up ADR-0086 already names.
