import { describe, expect, it } from 'vitest';
import { taskRequiresAgenticHarness } from './index.js';

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
