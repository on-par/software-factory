// src/cli/octokit.ts — the shared GitHub client: retry + throttling on every call (#641)

import { retry } from '@octokit/plugin-retry';
import { throttling } from '@octokit/plugin-throttling';
import { Octokit } from '@octokit/rest';

/** Rate-limit retries per request. Bounded so a genuinely exhausted quota surfaces to the
 *  caller instead of stalling a lane behind an unbounded backoff loop. */
export const MAX_THROTTLE_RETRIES = 2;

const FactoryOctokit = Octokit.plugin(retry, throttling);

export function onRateLimit(
  _retryAfter: number,
  _options: { method?: string; url?: string },
  _octokit: unknown,
  retryCount: number,
): boolean {
  return retryCount < MAX_THROTTLE_RETRIES;
}

export function onSecondaryRateLimit(
  _retryAfter: number,
  _options: { method?: string; url?: string },
  _octokit: unknown,
  retryCount: number,
): boolean {
  return retryCount < MAX_THROTTLE_RETRIES;
}

/** The client every CLI GitHub call goes through. `@octokit/plugin-retry` handles transient
 *  5xx/network failures with its default bounded backoff; the throttle handlers above cover
 *  primary and secondary rate limits (#641). */
export function createFactoryOctokit(token?: string): Octokit {
  return new FactoryOctokit({
    auth: token,
    throttle: { onRateLimit, onSecondaryRateLimit },
  }) as unknown as Octokit;
}
