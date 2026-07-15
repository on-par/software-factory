import { describe, expect, it } from 'vitest';
import { NON_RETRYABLE_FAILURE_REASONS, isRetryableFailure, taskRequiresAgenticHarness } from './index.js';

describe('taskRequiresAgenticHarness', () => {
  it('returns true for build tasks that edit files', () => {
    expect(taskRequiresAgenticHarness('build_codex')).toBe(true);
    expect(taskRequiresAgenticHarness('build_claude')).toBe(true);
  });

  it('returns false for non-build tasks', () => {
    expect(taskRequiresAgenticHarness('plan')).toBe(false);
    expect(taskRequiresAgenticHarness('review_pr')).toBe(false);
    expect(taskRequiresAgenticHarness('check_custom')).toBe(false);
  });
});

describe('NON_RETRYABLE_FAILURE_REASONS', () => {
  it('matches exactly the three deterministic reasons', () => {
    expect(NON_RETRYABLE_FAILURE_REASONS).toEqual(['schema_invalid', 'apply_failed', 'verify_failed']);
  });
});

describe('isRetryableFailure', () => {
  it.each(['schema_invalid', 'apply_failed', 'verify_failed'] as const)('returns false for %s', reason => {
    expect(isRetryableFailure(reason)).toBe(false);
  });

  it.each(['rate_limit', 'usage_cap', 'timeout', 'error', 'empty_response', 'unknown'] as const)('returns true for %s', reason => {
    expect(isRetryableFailure(reason)).toBe(true);
  });
});
