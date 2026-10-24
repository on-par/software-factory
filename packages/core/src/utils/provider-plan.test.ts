import { describe, expect, it, vi } from 'vitest';

import { detectProviderPlan, meteredPrimaryRouteWarnings, providerPlan } from './provider-plan.js';

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

describe('providerPlan', () => {
  const keyed = { ...claudeNone, env: { ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'k' }, readFile: noFile };
  const login = { ...claudeNone, env: { CLAUDE_CODE_OAUTH_TOKEN: 't' } };

  it('infers the harness from the anthropic and openai providers', () => {
    expect(providerPlan('anthropic', {}, keyed)).toBe('api');
    expect(providerPlan('anthropic', undefined, login)).toBe('subscription');
    expect(providerPlan('openai', {}, keyed)).toBe('api');
    expect(
      providerPlan(
        'openai',
        { harness: 'codex-cli' },
        { env: {}, exec: vi.fn(), readFile: () => '{"tokens":{"refresh_token":"r"}}', homedir: () => '/h' },
      ),
    ).toBe('subscription');
  });

  it('is unknown for a claude-cli model with an endpoint', () => {
    expect(providerPlan('anthropic', { harness: 'claude-cli', endpoint: 'https://gw' }, login)).toBe('unknown');
  });

  it('reads the opencode providerModel', () => {
    expect(providerPlan('custom', { harness: 'opencode', providerModel: 'opencode/x' })).toBe('api');
    expect(providerPlan('custom', { harness: 'opencode', providerModel: 'opencode-go/x' })).toBe('subscription');
    expect(providerPlan('custom', { harness: 'opencode' })).toBe('unknown');
  });

  it('is unknown for pi, ollama, command and undefined', () => {
    for (const harness of ['pi', 'ollama-http', 'command']) expect(providerPlan('custom', { harness })).toBe('unknown');
    expect(providerPlan(undefined, undefined)).toBe('unknown');
  });

  it('is unknown when a dep throws', () => {
    const boom = () => {
      throw new Error('boom');
    };
    expect(providerPlan('anthropic', { harness: 'claude-cli' }, { ...claudeNone, env: {}, fileExists: boom })).toBe(
      'unknown',
    );
  });
});

describe('meteredPrimaryRouteWarnings', () => {
  const defs: Record<string, { provider: string; harness: string }> = {
    'gpt-m': { provider: 'openai', harness: 'codex-cli' },
    'claude-m': { provider: 'anthropic', harness: 'claude-cli' },
  };
  const lookup = (m: string) => defs[m];
  const deps = { ...claudeNone, env: { CLAUDE_CODE_OAUTH_TOKEN: 't', OPENAI_API_KEY: 'k' }, readFile: noFile };

  it('names each metered pinned route and model once', () => {
    const lines = meteredPrimaryRouteWarnings({ plan: 'gpt-m', build: 'claude-m' }, lookup, deps);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^metered_primary_route:/);
    expect(lines[0]).toContain('plan');
    expect(lines[0]).toContain('gpt-m');
    expect(lines[0]).not.toContain("'k'");
  });

  it('has no lines without pins or when every pin is a subscription', () => {
    expect(meteredPrimaryRouteWarnings({}, lookup, deps)).toEqual([]);
    expect(meteredPrimaryRouteWarnings({ build: 'claude-m' }, lookup, deps)).toEqual([]);
  });
});
