// src/harness/classify.ts — shared failure classification for harnesses and the router.

import type { HarnessFailureReason } from './index.js';

/** Classify a failure from stderr/exit code. Shared by harnesses and the router. */
export function classifyFailure(stderr: string, exitCode: number): HarnessFailureReason {
  if (exitCode === 124) return 'timeout';
  const text = stderr.toLowerCase();
  if (/rate.?limit|429|too many requests/.test(text)) return 'rate_limit';
  if (/usage.?limit|quota|billing|insufficient|credit/.test(text)) return 'usage_cap';
  if (/empty|no content|no response/.test(text)) return 'empty_response';
  if (/error|fail|exception/.test(text)) return 'error';
  return 'unknown';
}
