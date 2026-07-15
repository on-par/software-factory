// src/router/failure-detail.ts — sanitized, truncated one-line failure detail
// for model-attempt failures. No imports from ./index.js to avoid cycles.

const MESSAGE_LIMIT = 200;
const STDERR_LIMIT = 400;

/** Redact common credential/token patterns before anything reaches logs. */
export function redactSecrets(text: string): string {
  return text
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, '[redacted]')
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]+/g, '[redacted]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]+/g, '[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/(api[_-]?key|token|secret|password|authorization)(\s*[=:]\s*)\S+/gi, '$1$2[redacted]');
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/**
 * One-line, sanitized, truncated description of a model-attempt failure.
 * Reads both top-level child-process fields (plain exec errors) and
 * HarnessError's `details` bag. Returns '' when there is nothing useful.
 */
export function describeFailureDetail(err: unknown): string {
  if (err === null || err === undefined) return '';
  if (typeof err !== 'object') return redactSecrets(truncate(collapse(String(err)), MESSAGE_LIMIT));
  const e = err as Record<string, unknown>;
  const details = (typeof e.details === 'object' && e.details !== null ? e.details : {}) as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof e.message === 'string' && e.message.trim()) {
    parts.push(`msg="${truncate(collapse(e.message), MESSAGE_LIMIT)}"`);
  }
  const code = e.code ?? details.code;
  if (typeof code === 'string' || typeof code === 'number') parts.push(`code=${code}`);
  const exitCode = e.exitCode ?? details.exitCode;
  if (typeof exitCode === 'number') parts.push(`exitCode=${exitCode}`);
  const signal = e.signal ?? details.signal;
  if (typeof signal === 'string' && signal) parts.push(`signal=${signal}`);
  if ((e.killed ?? details.killed) === true) parts.push('killed=true');
  const stderr = e.stderr ?? details.stderr;
  if (typeof stderr === 'string' && stderr.trim()) {
    parts.push(`stderr="${truncate(collapse(stderr), STDERR_LIMIT)}"`);
  }
  const tracePath = e.tracePath ?? details.tracePath;
  if (typeof tracePath === 'string' && tracePath) parts.push(`trace=${tracePath}`);
  return redactSecrets(parts.join(' '));
}
