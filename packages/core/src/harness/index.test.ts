import { describe, expect, it } from 'vitest';

import type { HarnessUsage } from './index.js';
import { isRetryableFailure, NON_RETRYABLE_FAILURE_REASONS, taskRequiresAgenticHarness } from './index.js';

describe('HarnessUsage', () => {
  it('keeps old usage shapes valid and accepts rollout metadata', () => {
    const originalUsage: HarnessUsage = { inputTokens: 10, outputTokens: 2 };
    const rolloutUsage: HarnessUsage = {
      ...originalUsage,
      numTurns: 3,
      peakInputTokens: 198303,
      contextWindow: 272000,
    };
    expect(rolloutUsage).toEqual({
      inputTokens: 10,
      outputTokens: 2,
      numTurns: 3,
      peakInputTokens: 198303,
      contextWindow: 272000,
    });
  });
});

describe('taskRequiresAgenticHarness', () => {
  it('returns true for build tasks that edit files', () => {
    expect(taskRequiresAgenticHarness('build_codex')).toBe(true);
    expect(taskRequiresAgenticHarness('build_claude')).toBe(true);
    expect(taskRequiresAgenticHarness('build_command')).toBe(true);
  });

  it('returns false for non-build tasks', () => {
    expect(taskRequiresAgenticHarness('plan')).toBe(false);
    expect(taskRequiresAgenticHarness('review_pr')).toBe(false);
    expect(taskRequiresAgenticHarness('check_custom')).toBe(false);
  });
});

describe('NON_RETRYABLE_FAILURE_REASONS', () => {
  it('matches exactly the three deterministic reasons', () => {
    expect(NON_RETRYABLE_FAILURE_REASONS).toEqual([
      'schema_invalid',
      'apply_failed',
      'verify_failed',
      'permission_denied',
    ]);
  });
});

describe('isRetryableFailure', () => {
  it.each(['schema_invalid', 'apply_failed', 'verify_failed', 'permission_denied'] as const)(
    'returns false for %s',
    (reason) => {
      expect(isRetryableFailure(reason)).toBe(false);
    },
  );

  it.each([
    'rate_limit',
    'usage_cap',
    'timeout',
    'error',
    'empty_response',
    'unavailable',
    'local_auth',
    'unknown',
  ] as const)('returns true for %s', (reason) => {
    expect(isRetryableFailure(reason)).toBe(true);
  });
});
