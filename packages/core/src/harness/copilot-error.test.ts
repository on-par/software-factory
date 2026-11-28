import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { classifyCopilotFailure, classifyCopilotSessionError } from './copilot-error.js';

const FIXTURES = new URL('../__fixtures__/copilot-cli/', import.meta.url);

function sessionErrorData(name: string): Record<string, unknown> {
  const raw = readFileSync(fileURLToPath(new URL(`copilot-cli-synthetic-1.0.114.${name}.jsonl`, FIXTURES)), 'utf8');
  const errorLine = raw.split('\n').find((l) => l.includes('"type":"session.error"')) ?? '{}';
  const event = JSON.parse(errorLine) as { data?: Record<string, unknown> };
  return event.data ?? {};
}

describe('classifyCopilotSessionError', () => {
  it.each([
    ['a rejected token', 'error-token-rejected', 'local_auth', 'auth', 'the Copilot token was rejected'],
    [
      'a used-up allowance (pattern documented-only)',
      'error-allowance',
      'usage_cap',
      'usage_cap',
      'the Copilot premium request allowance is used up',
    ],
    ['a 429 (pattern documented-only)', 'error-rate-limit', 'rate_limit', 'rate_limit', undefined],
  ])('maps %s to its reason and kind (synthetic 1.0.114 fixture)', (_label, name, reason, kind, cause) => {
    const failure = classifyCopilotSessionError(sessionErrorData(name));
    expect([failure?.reason, failure?.kind, failure?.cause]).toEqual([reason, kind, cause]);
  });

  it.each([
    ['errorCode no_account', { errorType: 'authentication', errorCode: 'no_account', message: 'x' }, 'local_auth'],
    ['statusCode 402 alone', { errorType: 'query', message: 'x', statusCode: 402 }, 'usage_cap'],
    ['statusCode 429 alone', { errorType: 'query', message: 'x', statusCode: 429 }, 'rate_limit'],
    ['a user_*_rate_limited errorCode', { errorType: 'query', errorCode: 'user_weekly_rate_limited' }, 'rate_limit'],
  ])('maps documented ErrorData %s (documented-only)', (_label, data, reason) => {
    expect(classifyCopilotSessionError(data)?.reason).toBe(reason);
  });

  it('names the missing credential for no_account and leaves other error types to text classification', () => {
    expect(classifyCopilotSessionError({ errorType: 'authentication', errorCode: 'no_account' })?.cause).toBe(
      'no Copilot credential: set COPILOT_GITHUB_TOKEN or run `copilot login`',
    );
    expect(classifyCopilotSessionError({ errorType: 'context_limit', message: 'too long' })).toBeUndefined();
  });
});

describe('classifyCopilotFailure', () => {
  it.each([
    ['no credential (docs string)', 'Error: No authentication information found', 'local_auth', 'unavailable'],
    ['rejected token (docs string)', 'Error: Authentication failed', 'local_auth', 'auth'],
    [
      'expired or unauthorized token (docs string)',
      'Your GitHub token may be invalid, expired, or lacking the required permissions.',
      'local_auth',
      'auth',
    ],
    [
      'classic token (docs string)',
      'Error: Classic Personal Access Tokens (ghp_) are not supported by Copilot.',
      'local_auth',
      'auth',
    ],
    [
      'no plan or organization policy (docs string; pattern documented-only)',
      'Error: Access denied by policy settings',
      'local_auth',
      'auth',
    ],
    [
      'denied tool call (public issue report wording, used by the synthetic 1.0.114 fixture)',
      'Permission denied and could not request permission from user',
      'permission_denied',
      'other',
    ],
    ['quota exhausted (changelog wording; pattern documented-only)', 'Quota exceeded', 'usage_cap', 'usage_cap'],
    [
      'premium requests exhausted (pattern documented-only)',
      'premium requests exhausted for this month',
      'usage_cap',
      'usage_cap',
    ],
    [
      'session rate limit (changelog wording; pattern documented-only)',
      'session rate limit reached',
      'rate_limit',
      'rate_limit',
    ],
    ['HTTP 429 text (pattern documented-only)', 'query: Too Many Requests (status 429)', 'rate_limit', 'rate_limit'],
  ])('%s', (_label, text, reason, kind) => {
    expect(classifyCopilotFailure(text, 1)).toMatchObject({ reason, kind });
  });

  it('gives a cause for every Copilot-specific match and none for generic failures', () => {
    expect(classifyCopilotFailure('Error: Classic Personal Access Tokens (ghp_) are not supported', 1).cause).toBe(
      'classic tokens (ghp_) are not supported; use a fine-grained github_pat_ token with the Copilot Requests permission',
    );
    expect(classifyCopilotFailure('Error: Access denied by policy settings', 1).cause).toBe(
      'no Copilot plan, or the organization does not allow Copilot CLI',
    );
    expect(classifyCopilotFailure('unexpected error in session', 1)).toEqual({
      kind: 'unavailable',
      reason: 'error',
      detail: 'unexpected error in session',
    });
  });

  it('falls back to exit-code classification and caps the detail', () => {
    expect(classifyCopilotFailure('', 127).reason).toBe('cli_missing');
    expect(classifyCopilotFailure('x'.repeat(1000), 1).detail).toHaveLength(400);
  });
});
