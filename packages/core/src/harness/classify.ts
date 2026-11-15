import type { HarnessFailureReason } from './index.js';

const REJECTED_CREDENTIAL_RE = /\bauthentication_error\b|(?:invalid|incorrect) (?:x-)?api[\s_-]?key/;

export function isRejectedCredentialText(text: string): boolean {
  return REJECTED_CREDENTIAL_RE.test(text.toLowerCase());
}

export function classifyFailure(stderr: string, exitCode: number): HarnessFailureReason {
  if (exitCode === 124) return 'timeout';
  const text = stderr.toLowerCase();
  if (exitCode === 127 || /\benoent\b|command not found|: not found\b/.test(text)) return 'cli_missing';
  if (/failed to authenticate|oauth session expired|could not be refreshed|please (run )?\/?login/.test(text))
    return 'local_auth';
  if (/missing bearer|\b401\b[^\n]{0,20}unauthori[sz]ed/.test(text)) return 'local_auth';
  if (REJECTED_CREDENTIAL_RE.test(text)) return 'local_auth';
  if (/no auth credentials found/.test(text)) return 'local_auth';
  if (
    /rate[\s_-]?limit|too many requests/.test(text) ||
    (/\b429\b/.test(text) && /http|status|response|retry[\s-]?after|too many/.test(text))
  )
    return 'rate_limit';
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
