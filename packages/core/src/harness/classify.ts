// src/harness/classify.ts — shared failure classification for harnesses and the router.

import type { HarnessFailureReason } from './index.js';

/** A provider rejected a credential it was given (revoked or wrong key), as opposed to a signed-out CLI (#3232). */
const REJECTED_CREDENTIAL_RE = /\bauthentication_error\b|(?:invalid|incorrect) (?:x-)?api[\s_-]?key/;

/** True when the text reports a rejected credential; signed-out text such as "no auth credentials found" is false. */
export function isRejectedCredentialText(text: string): boolean {
  return REJECTED_CREDENTIAL_RE.test(text.toLowerCase());
}

/** Classify a failure from provider output/exit code. Shared by harnesses and the router. */
export function classifyFailure(stderr: string, exitCode: number): HarnessFailureReason {
  if (exitCode === 124) return 'timeout';
  const text = stderr.toLowerCase();
  if (exitCode === 127 || /\benoent\b|command not found|: not found\b/.test(text)) return 'cli_missing';
  if (/failed to authenticate|oauth session expired|could not be refreshed|please (run )?\/?login/.test(text))
    return 'local_auth';
  // Codex CLI without a login: `unexpected status 401 Unauthorized: Missing bearer ...` (#2494).
  if (/missing bearer|\b401\b[^\n]{0,20}unauthori[sz]ed/.test(text)) return 'local_auth';
  // Provider 401 bodies as surfaced by Pi: Anthropic `authentication_error`, OpenAI
  // "Incorrect API key provided", OpenRouter "No auth credentials found" (#2901).
  if (REJECTED_CREDENTIAL_RE.test(text)) return 'local_auth';
  // Signed out (no credentials configured at all): still local_auth, but not a rejected credential (#3232).
  if (/no auth credentials found/.test(text)) return 'local_auth';
  // Codex/ChatGPT limit patterns below target Codex CLI (ChatGPT plan/usage-cap) output.
  // Codex CLI version: 0.144.6 as of 2026-07-20. Revisit when Codex changes its wording;
  // real samples can be harvested from .factory/events.ndjson (failoverReason/stderr fields).
  //
  // Codex/ChatGPT rate limits: explicit "rate limit" wording, "too many requests",
  // or an HTTP 429 that appears in an HTTP/status/retry context (not a bare line number).
  if (
    /rate[\s_-]?limit|too many requests/.test(text) ||
    (/\b429\b/.test(text) && /http|status|response|retry[\s-]?after|too many/.test(text))
  )
    return 'rate_limit';
  // Codex/ChatGPT usage/plan caps: usage-limit, plan-limit, monthly/weekly/daily limit,
  // "usage cap", quota/billing, a cap-qualified insufficient/credit phrase, and the
  // "your limit … resets at <time>" variant. `insufficient`/`credit` are required to be
  // followed by a cap/billing noun so bare substrings (e.g. "insufficient permissions",
  // "accreditation") don't false-positive (#1520).
  if (
    /usage[\s_-]?limit|plan[\s_-]?limit|(?:monthly|weekly|daily)[\s_-]?limit|usage cap|quota|billing|insufficient\s+(?:quota|credits?|balance|funds)|credits?\s+(?:exhausted|depleted|balance)|\blimit\b.{0,30}\breset/.test(
      text,
    )
  )
    return 'usage_cap';
  if (/empty|no content|no response/.test(text)) return 'empty_response';
  if (/schema[_ ]?invalid/.test(text)) return 'schema_invalid';
  if (/apply[_ ]?failed/.test(text)) return 'apply_failed';
  if (/verify[_ ]?failed|verification failed/.test(text)) return 'verify_failed';
  if (/error|fail|exception/.test(text)) return 'error';
  return 'unknown';
}
