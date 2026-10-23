import { describe, expect, it, vi } from 'vitest';

import { detectProviderPlan } from './provider-plan.js';

const noFile = () => {
  throw new Error('ENOENT');
};
const noLogin = () => {
  throw new Error('not logged in');
};
const claudeNone = { platform: 'linux' as const, fileExists: () => false, readFile: noFile };

describe('detectProviderPlan', () => {
  it('detectProviderPlan treats any API key as metered', () => {
    expect(detectProviderPlan('anthropic', { ...claudeNone, env: { ANTHROPIC_API_KEY: 'k' } })).toBe('api');
    expect(detectProviderPlan('codex', { env: { OPENAI_API_KEY: 'k' }, readFile: noFile })).toBe('api');
    expect(detectProviderPlan('openai', { env: { CODEX_API_KEY: 'k' }, readFile: noFile })).toBe('api');
  });

  it('detectProviderPlan is subscription for a Codex ChatGPT login without an API key', () => {
    const readFile = () => JSON.stringify({ tokens: { refresh_token: 'r' } });
    expect(detectProviderPlan('codex', { env: {}, exec: vi.fn(), readFile, homedir: () => '/h' })).toBe('subscription');
  });

  it('detectProviderPlan classifies OpenCode Go as subscription and Zen as api', () => {
    expect(detectProviderPlan('opencode-go/deepseek-v4-flash')).toBe('subscription');
    expect(detectProviderPlan('opencode-go')).toBe('subscription');
    expect(detectProviderPlan('opencode/some-model')).toBe('api');
  });

  it('matches claude to anthropic', () => {
    const deps = { ...claudeNone, env: {} };
    expect(detectProviderPlan('claude', deps)).toBe(detectProviderPlan('anthropic', deps));
    expect(detectProviderPlan('claude', { ...deps, env: { CLAUDE_CODE_OAUTH_TOKEN: 't' } })).toBe('subscription');
  });

  it('is unknown for empty, unrecognised, differently cased and bare opencode ids', () => {
    for (const id of ['', 'ollama', 'Anthropic', 'opencode', 'deepseek/x', 'openrouter/x']) {
      expect(detectProviderPlan(id)).toBe('unknown');
    }
  });

  it('trims padding around the id', () => {
    expect(detectProviderPlan(' opencode-go ')).toBe('subscription');
  });

  it('is unknown for Codex with no key and a failing login probe', () => {
    expect(detectProviderPlan('codex', { env: {}, exec: noLogin, readFile: noFile, homedir: () => '/h' })).toBe(
      'unknown',
    );
  });
});
