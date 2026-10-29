// src/usage/constants.ts — The usage poll interval, which config/disk-policy.ts uses as its retry interval.

export const DEFAULT_USAGE_POLL_MS = 5 * 60_000; // 5 min; well under the 5-hour account window
