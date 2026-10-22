import { describe, expect, it, vi } from 'vitest';

import { detectProviderPlan } from './provider-plan.js';

const noFile = () => {
  throw new Error('ENOENT');
};
const chatgpt = JSON.stringify({ tokens: { access_token: 'opaque', refresh_token: 'r' } });

describe('detectProviderPlan', () => {
  it('detectProviderPlan treats any API key as metered', () => {
    expect(detectProviderPlan('anthropic', { env: { ANTHROPIC_API_KEY: 'x' } })).toBe('api');
    expect(detectProviderPlan('openai', { env: { OPENAI_API_KEY: 'k' }, readFile: noFile })).toBe('api');
    expect(
      detectProviderPlan('codex', {
        env: { CODEX_HOME: '/c' },
        readFile: () => JSON.stringify({ OPENAI_API_KEY: 'k' }),
      }),
    ).toBe('api');
  });

  it('detectProviderPlan reports subscription for a Codex ChatGPT login', () => {
    const exec = vi.fn();
    expect(detectProviderPlan('openai', { env: { CODEX_HOME: '/c' }, exec, readFile: () => chatgpt })).toBe(
      'subscription',
    );
  });

  it('is unknown for Codex with no key and no login', () => {
    const exec = () => {
      throw new Error('exit 1');
    };
    expect(detectProviderPlan('codex', { env: {}, exec, readFile: noFile })).toBe('unknown');
  });

  it('follows Claude auth for anthropic', () => {
    expect(
      detectProviderPlan('anthropic', {
        env: { CLAUDE_CODE_OAUTH_TOKEN: 't' },
        platform: 'linux',
        fileExists: () => false,
      }),
    ).toBe('subscription');
  });

  it('detectProviderPlan maps opencode-go to subscription and opencode Zen to api', () => {
    expect(detectProviderPlan('opencode-go/deepseek-v4-flash')).toBe('subscription');
    expect(detectProviderPlan('opencode/deepseek-v4-flash-free')).toBe('api');
  });

  it('is unknown for empty, unrecognised or slashless ids', () => {
    for (const id of ['', 'ollama', 'pi', 'opencode-go', 'opencode', 'custom']) {
      expect(detectProviderPlan(id)).toBe('unknown');
    }
  });
});
