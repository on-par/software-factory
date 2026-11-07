# Event log reads and cursors

`factory logs --json --limit <n>` prints the newest `n` matching events (oldest first) by reading
`.factory/state/events.ndjson` backwards in chunks, so the cost does not grow with the file.
`factory logs --json --since <cursor>` prints only events after a cursor. With either flag each
`--json` line carries an additive `cursor` string: the position just after that event.

- The cursor is opaque. Pass back the `cursor` of the last event you saw. When nothing comes back,
  keep your previous cursor.
- `--since` with `--limit` returns the first `n` events after the cursor (forward paging).
- A bad cursor exits 1 and writes one JSON object to stderr:
  `{"error":"malformed-cursor"|"unknown-cursor","message":"..."}`. A bad `--limit` gives
  `{"error":"invalid-limit",...}`.

Bare `factory logs`, `--json` and `--follow` start from the full history: rotated segments in
`state/logs/events/` oldest first, then the live file. `--limit` and `--since` are the cheap paged paths.

## Segment naming

Cursors encode a segment id and a byte offset. A segment id is the segment's start offset in the
global byte stream of every event line ever written. Rotated segments live in
`state/logs/events/` as `events-<16-digit start offset>.ndjson`. The live file's id is the newest
rotated segment's id plus its size (0 when none exist), so renaming the live file to its segment
name keeps old cursors valid. Retention must not delete the newest rotated segment.

## PR-persisted run state events

A run for an issue with an open factory PR keeps its resumable state in one hidden factory comment on that PR
(ADR-0174), so a fresh clone on a disposable host can continue. Three event kinds report it:

- `pr_state_loaded` (info): the run restored state from the PR, with the handled review-rework rounds, the rounds
  remaining under the cap, the CHECK rework rounds and the status.
- `pr_state_ignored` (warn): a state comment on the PR was not trusted. The reason is `untrusted-author`,
  `digest-mismatch`, `key-mismatch`, `malformed` or `identity-unavailable` (the token's identity could not be read,
  for example a revoked token or a GitHub outage).
- `pr_state_failed` (info): the PR lookup, restore or save failed. The run continues on local state.

A feedback round on a factory PR (`factory respond <pr>` or a queued review rework, #3910) logs two more:

- `feedback_round_triaged` (info): the round read the PR's unhandled trusted feedback, with the item count and the
  number triaged actionable, question and out-of-scope.
- `feedback_round_replied` (info): the round answered its items, with the replies posted, the threads resolved and
  the reviewers re-requested. A failed reply, resolve or review request logs a `rework` warning and the round goes on.
