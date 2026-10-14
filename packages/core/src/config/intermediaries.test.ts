import { describe, expect, it } from 'vitest';

import { intermediaryFor } from './intermediaries.js';

describe('intermediaryFor', () => {
  it('finds OpenCode Go with its review date', () => {
    expect(intermediaryFor('opencode-go/deepseek-v4-flash')).toMatchObject({
      name: 'OpenCode Go',
      reviewBy: '2026-10-31',
    });
  });

  it('finds OpenRouter', () => {
    expect(intermediaryFor('openrouter/deepseek/deepseek-chat')?.name).toBe('OpenRouter');
  });

  it('matches the prefix case-insensitively', () => {
    expect(intermediaryFor('OPENCODE-GO/x')?.name).toBe('OpenCode Go');
  });

  it.each(['claude-sonnet-5', 'opencode/deepseek-v4-flash-free', ''])('returns undefined for %j', (pm) => {
    expect(intermediaryFor(pm)).toBeUndefined();
  });
});
