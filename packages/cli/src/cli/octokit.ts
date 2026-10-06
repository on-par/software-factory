// src/cli/octokit.ts — the shared GitHub client: retry + throttling on every call (#641),
// deprecated-route detection once per route (#2218)

import { styleText } from 'node:util';

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

/** One deprecated REST route, as reported by GitHub's Deprecation/Sunset/Link headers (#2218). */
export interface GitHubApiDeprecation {
  /** Upper-case, e.g. 'POST'. */
  method: string;
  /** Route template, e.g. '/repos/{owner}/{repo}/issues'. */
  route: string;
  /** Raw Sunset header, e.g. 'Fri, 10 Mar 2028 00:00:00 GMT'. */
  sunset?: string;
  /** 'YYYY-MM-DD' (UTC) when Sunset parses, e.g. '2028-03-10'. */
  sunsetDate?: string;
  /** The rel="deprecation" URL from the Link header. */
  link?: string;
}

export interface FactoryOctokitOptions {
  /** Receives each deprecated METHOD route once per client — shipIssue turns it into a github_api_deprecated event. */
  log?: (deprecation: GitHubApiDeprecation) => void;
  /** Where the short per-route line goes. Defaults to console.error. Injectable for tests. */
  stderr?: (line: string) => void;
}

type ResponseHeaders = Record<string, string | number | undefined>;

/** True for Octokit's raw `[@octokit/request] "…" is deprecated.` warn line. */
export function isOctokitDeprecationWarning(message: string): boolean {
  return /^\[@octokit\/request\] ".*" is deprecated\./.test(message);
}

/** Reads GitHub's deprecation headers (Octokit lower-cases header keys); undefined when not deprecated. */
export function readDeprecation(
  method: string,
  route: string,
  headers: ResponseHeaders,
): GitHubApiDeprecation | undefined {
  if (!('deprecation' in headers)) return undefined;
  const deprecation: GitHubApiDeprecation = { method: method.toUpperCase(), route };
  if (headers.sunset !== undefined) {
    deprecation.sunset = String(headers.sunset);
    const time = new Date(deprecation.sunset);
    if (!Number.isNaN(time.getTime())) deprecation.sunsetDate = time.toISOString().slice(0, 10);
  }
  const link = String(headers.link ?? '').match(/<([^<>]+)>; rel="deprecation"/)?.[1];
  if (link !== undefined) deprecation.link = link;
  return deprecation;
}

export function formatDeprecation(d: GitHubApiDeprecation): string {
  return `GitHub API deprecated: ${d.method} ${d.route} — sunset ${d.sunsetDate ?? d.sunset ?? 'unknown'}${d.link ? ` (see ${d.link})` : ''}`;
}

/** The client every CLI GitHub call goes through. `@octokit/plugin-retry` handles transient
 *  5xx/network failures with its default bounded backoff; the throttle handlers above cover
 *  primary and secondary rate limits (#641). Deprecated routes are reported once per client (#2218). */
export function createFactoryOctokit(token?: string, options: FactoryOctokitOptions = {}): Octokit {
  const seen = new Set<string>();
  const stderr = options.stderr ?? ((line: string) => console.error(line));
  const log = {
    debug: () => {},
    info: () => {},
    warn: (message: string) => {
      if (!isOctokitDeprecationWarning(message)) console.warn(message);
    },
    error: (message: string) => console.error(message),
  };
  const octokit = new FactoryOctokit({
    auth: token,
    throttle: { onRateLimit, onSecondaryRateLimit },
    log,
    // @octokit/request reads its own `request.log` (default console), not the client's `log`.
    request: { log },
  });
  const record = (opts: { method?: string; url?: string }, headers: ResponseHeaders | undefined): void => {
    try {
      if (!headers || !opts.method || !opts.url) return;
      const d = readDeprecation(opts.method, opts.url, headers);
      if (!d) return;
      const key = `${d.method} ${d.route}`;
      if (seen.has(key)) return;
      seen.add(key);
      stderr(styleText('yellow', formatDeprecation(d)));
      options.log?.(d);
    } catch {
      // observability only — never break the call
    }
  };
  octokit.hook.after('request', (response, opts) =>
    record(opts as { method?: string; url?: string }, response.headers as ResponseHeaders),
  );
  octokit.hook.error('request', (error, opts) => {
    record(
      opts as { method?: string; url?: string },
      (error as { response?: { headers?: ResponseHeaders } }).response?.headers,
    );
    throw error;
  });
  return octokit;
}
