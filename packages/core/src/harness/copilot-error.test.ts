import { describe, expect, it } from 'vitest';

import { classifyCopilotFailure } from './copilot-error.js';

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
    ['no plan or organization policy (docs string)', 'Error: Access denied by policy settings', 'local_auth', 'auth'],
    [
      'denied tool call (unverified: from a public issue report)',
      'Permission denied and could not request permission from user',
      'permission_denied',
      'other',
    ],
    ['quota exhausted (unverified: changelog wording only)', 'Quota exceeded', 'usage_cap', 'usage_cap'],
    ['premium requests exhausted (unverified)', 'premium requests exhausted for this month', 'usage_cap', 'usage_cap'],
    [
      'session rate limit (unverified: changelog wording only)',
      'session rate limit reached',
      'rate_limit',
      'rate_limit',
    ],
    ['HTTP 429 (unverified)', 'api: Too Many Requests (status 429)', 'rate_limit', 'rate_limit'],
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
