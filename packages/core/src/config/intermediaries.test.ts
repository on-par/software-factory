import { describe, expect, it } from 'vitest';

import { APPROVED_INTERMEDIARIES, approvedIntermediaryNames, directDeepSeekReason } from './intermediaries.js';

describe('APPROVED_INTERMEDIARIES', () => {
  it('approves OpenRouter and OpenCode Go and leaves Azure Foundry pending', () => {
    const byName = Object.fromEntries(APPROVED_INTERMEDIARIES.map((i) => [i.name, i]));
    expect(byName['OpenRouter']?.status).toBe('approved');
    expect(byName['OpenCode Go']).toMatchObject({ status: 'approved', reviewBy: '2026-10-31' });
    expect(byName['Azure Foundry']?.status).toBe('pending');
    expect(approvedIntermediaryNames()).toEqual(['OpenRouter', 'OpenCode Go']);
  });
});

type Def = Parameters<typeof directDeepSeekReason>[0];
const reason = (def: Partial<Def>) => directDeepSeekReason({ envKey: null, ...def });

describe('directDeepSeekReason', () => {
  it.each(['deepseek/deepseek-chat', 'DeepSeek/x', 'deepseek'])('flags providerModel %s', (providerModel) => {
    expect(reason({ providerModel })).toContain('native deepseek/ provider');
  });

  it.each(['DEEPSEEK_API_KEY', 'deepseek_api_key'])('flags envKey %s', (envKey) => {
    expect(reason({ envKey })).toContain('DEEPSEEK_API_KEY');
  });

  it('flags api.deepseek.com in claudeFlag', () => {
    expect(reason({ claudeFlag: 'https://api.deepseek.com' })).toBe('claudeFlag points at api.deepseek.com');
  });

  it('flags api.deepseek.com in providerModel', () => {
    expect(reason({ providerModel: 'openrouter/https://api.deepseek.com' })).toBe(
      'providerModel points at api.deepseek.com',
    );
  });

  it('flags api.deepseek.com in providerOptions', () => {
    expect(reason({ providerOptions: { baseURL: 'https://api.deepseek.com/v1' } })).toBe(
      'providerOptions.baseURL points at api.deepseek.com',
    );
  });

  it('flags nested providerOptions and names the path', () => {
    expect(reason({ providerOptions: { options: { urls: ['https://API.deepseek.com'] } } })).toBe(
      'providerOptions.options.urls.0 points at api.deepseek.com',
    );
  });

  it.each(['openrouter/deepseek/deepseek-v4-flash', 'opencode-go/deepseek-v4-flash', 'anthropic/claude-sonnet-5'])(
    'accepts providerModel %s',
    (providerModel) => {
      expect(reason({ providerModel })).toBeNull();
    },
  );

  it('accepts an empty def and non-string providerOptions', () => {
    expect(reason({})).toBeNull();
    expect(reason({ providerOptions: { n: 1, b: true, z: null, nested: [2, { f: false }] } })).toBeNull();
  });
});
