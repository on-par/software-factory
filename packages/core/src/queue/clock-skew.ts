// packages/core/src/queue/clock-skew.ts — local clock skew against GitHub's Date header, so the stale-claim reaper can refuse to reap on a drifting clock (#3149).

import { defaultFactoryConfig } from '@on-par/factory-config';

import type { FactoryConfig } from '../config/index.js';

/** Default largest tolerated |local - GitHub| clock difference before the reaper refuses (#3149). */
export const DEFAULT_MAX_CLOCK_SKEW_MS = defaultFactoryConfig.queue.maxClockSkewMs;

/** How long a successful skew measurement is reused (#3149). */
export const CLOCK_SKEW_CACHE_TTL_MS = 10 * 60_000;

/** Parses an HTTP `Date` header to epoch ms; null when missing or unparsable. */
export function parseHttpDateMs(header: string | undefined): number | null {
  if (!header) return null;
  const ms = Date.parse(header);
  return Number.isNaN(ms) ? null : ms;
}

export interface ClockSkewCache {
  get(nowMs: number): number | undefined;
  set(nowMs: number, skewMs: number): void;
  clear(): void;
}

export function createClockSkewCache(ttlMs: number = CLOCK_SKEW_CACHE_TTL_MS): ClockSkewCache {
  let entry: { at: number; skewMs: number } | undefined;
  return {
    get(nowMs) {
      return entry && nowMs - entry.at < ttlMs ? entry.skewMs : undefined;
    },
    set(nowMs, skewMs) {
      entry = { at: nowMs, skewMs };
    },
    clear() {
      entry = undefined;
    },
  };
}

/** Module level because the cycle reaper builds a fresh client every cycle. */
export const defaultClockSkewCache: ClockSkewCache = createClockSkewCache();

/** Local now minus the server's clock, in ms: positive means the local clock is fast. Null when
 *  it cannot be measured (the caller then fails open); failures are never cached. */
export async function measureClockSkew(opts: {
  serverDate: () => Promise<string | undefined>;
  now?: () => number;
  cache?: ClockSkewCache;
}): Promise<number | null> {
  const now = opts.now ?? Date.now;
  const cached = opts.cache?.get(now());
  if (cached !== undefined) return cached;
  let header: string | undefined;
  try {
    header = await opts.serverDate();
  } catch {
    return null;
  }
  const serverMs = parseHttpDateMs(header);
  if (serverMs === null) return null;
  const skewMs = now() - serverMs;
  opts.cache?.set(now(), skewMs);
  return skewMs;
}

type RateLimitOctokit = { rest: { rateLimit: { get(): Promise<{ headers?: Record<string, unknown> }> } } };

/** GitHub's `Date` header from `GET /rate_limit`, which does not count against the rate limit. */
export async function githubServerDate(octokit: RateLimitOctokit): Promise<string | undefined> {
  const res = await octokit.rest.rateLimit.get();
  const date = res.headers?.date;
  return typeof date === 'string' ? date : undefined;
}

/** Measures skew from GitHub's `Date` header. */
export async function measureGithubClockSkew(
  octokit: RateLimitOctokit,
  opts: { now?: () => number; cache?: ClockSkewCache } = {},
): Promise<number | null> {
  return measureClockSkew({
    serverDate: () => githubServerDate(octokit),
    now: opts.now,
    cache: opts.cache,
  });
}

export function isClockSkewExcessive(skewMs: number | null, maxClockSkewMs: number): boolean {
  return skewMs !== null && Math.abs(skewMs) > maxClockSkewMs;
}

/** Max tolerated clock skew in ms for the stale-claim reaper, from validated config (#3149). */
export function resolveQueueMaxClockSkewMs(config: FactoryConfig): number {
  return config.queue?.maxClockSkewMs ?? defaultFactoryConfig.queue.maxClockSkewMs;
}
