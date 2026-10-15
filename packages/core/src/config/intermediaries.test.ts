import { defaultModelsConfig } from '@on-par/factory-config';
import { describe, expect, it } from 'vitest';

import { claudeEndpointIntermediary, intermediaryFor } from './intermediaries.js';

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

describe('packaged pi models', () => {
  it('every packaged pi model routes through an approved (not pending) intermediary (#2904)', () => {
    const piModels = Object.entries(defaultModelsConfig.models).filter(([, m]) => m.harness === 'pi');
    expect(piModels.length).toBeGreaterThan(0);
    for (const [id, m] of piModels) {
      expect(intermediaryFor(m.providerModel ?? '')?.status, id).toBe('approved');
    }
  });
});

describe('claudeEndpointIntermediary (#2906)', () => {
  it.each(['https://openrouter.ai/api', 'https://OpenRouter.ai/api'])('accepts %s', (url) => {
    expect(claudeEndpointIntermediary(url)?.name).toBe('OpenRouter');
  });

  it.each([
    'http://openrouter.ai/api',
    'https://api.deepseek.com/anthropic',
    'https://opencode.ai/zen/go',
    'https://ai.azure.com/x',
    'https://openrouter.ai.evil.com',
    'https://evil-openrouter.ai',
    'not a url',
    '',
  ])('rejects %s', (url) => {
    expect(claudeEndpointIntermediary(url)).toBeUndefined();
  });
});
