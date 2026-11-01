# ADR-0171: Hosted base CI gates merges

- Status: Accepted

Local base verification may omit checks run on pushes. A completed hosted code-health failure therefore makes the base red even when local verification passes. Pending and unavailable hosted results do not create a new local base hold.

Landing checks hosted CI for the current base head before and within the merge lock. Pending results wait for up to thirty minutes; failures and unavailable results leave the PR open. Repositories without code-health checks continue without that hosted gate. A recorded factory merge followed by a failed descendant base creates a persisted per-repo merge pause and a single `red-main` event. Only a green hosted base clears the pause and emits `red-main-cleared`.
