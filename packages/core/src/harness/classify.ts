// src/harness/classify.ts — shared failure classification for harnesses and the router.

import type { HarnessFailureReason } from './index.js';

/** Classify a failure from stderr/exit code. Shared by harnesses and the router. */
export function classifyFailure(stderr: string, exitCode: number): HarnessFailureReason {
  if (exitCode === 124) return 'timeout';
  const text = stderr.toLowerCase();
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
  // "usage cap", quota/billing/credit, and the "your limit … resets at <time>" variant.
  if (
    /usage[\s_-]?limit|plan[\s_-]?limit|(?:monthly|weekly|daily)[\s_-]?limit|usage cap|quota|billing|insufficient|credit|\blimit\b.{0,30}\breset/.test(
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
