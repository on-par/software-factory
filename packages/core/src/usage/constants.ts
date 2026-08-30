// src/usage/constants.ts — Shared constants for coordinator.ts and grant-ledger.ts,
// split out to avoid a circular import between the two (coordinator.ts imports the
// grant-ledger admission API; grant-ledger.ts's TTL default derives from the poll
// interval).

export const DEFAULT_USAGE_POLL_MS = 5 * 60_000; // 5 min; well under the 5-hour account window
