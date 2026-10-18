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

## Segment naming

Cursors encode a segment id and a byte offset. A segment id is the segment's start offset in the
global byte stream of every event line ever written. Rotated segments live in
`state/logs/events/` as `events-<16-digit start offset>.ndjson`. The live file's id is the newest
rotated segment's id plus its size (0 when none exist), so renaming the live file to its segment
name keeps old cursors valid. Retention must not delete the newest rotated segment.
