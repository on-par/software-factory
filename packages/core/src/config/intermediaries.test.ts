import { defaultModelsConfig } from '@on-par/factory-config';
import { describe, expect, it } from 'vitest';

import {
  assertNoDirectDeepSeek,
  claudeEndpointIntermediary,
  directDeepSeekReason,
  intermediaryFor,
} from './intermediaries.js';

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

describe('directDeepSeekReason (ADR-0163)', () => {
  const reason = (d: Partial<Parameters<typeof directDeepSeekReason>[0]>) =>
    directDeepSeekReason({ envKey: null, ...d });

  it.each(['deepseek/deepseek-chat', 'DeepSeek/x', ' deepseek/x', 'deepseek'])('flags providerModel %s', (pm) => {
    expect(reason({ providerModel: pm })).toMatch(/native deepseek\/ provider/);
  });

  it.each(['openrouter/deepseek/deepseek-v4-flash', 'opencode-go/deepseek-v4-pro', 'deepseek-community/x', undefined])(
    'does not flag providerModel %s',
    (pm) => {
      expect(reason({ providerModel: pm })).toBeUndefined();
    },
  );

  it('flags envKey DEEPSEEK_API_KEY but not null or other keys', () => {
    expect(reason({ envKey: 'DEEPSEEK_API_KEY' })).toMatch(/DEEPSEEK_API_KEY/);
    expect(reason({ envKey: null })).toBeUndefined();
    expect(reason({ envKey: 'OPENROUTER_API_KEY' })).toBeUndefined();
  });

  it('flags api.deepseek.com in providerOptions at any depth and case', () => {
    expect(reason({ providerOptions: { baseURL: 'https://api.deepseek.com/v1' } })).toMatch(/providerOptions\.baseURL/);
    expect(reason({ providerOptions: { provider: { options: { baseURL: 'https://API.DEEPSEEK.COM' } } } })).toMatch(
      /api\.deepseek\.com/,
    );
    expect(reason({ providerOptions: { urls: ['https://api.deepseek.com'] } })).toMatch(/api\.deepseek\.com/);
  });

  it('ignores non-string providerOptions values', () => {
    expect(reason({ providerOptions: { n: 1, b: true, z: null, o: {}, a: [] } })).toBeUndefined();
  });

  it('flags a claudeFlag on api.deepseek.com but not deepseek/ behind an approved endpoint', () => {
    expect(reason({ claudeFlag: 'https://api.deepseek.com/anthropic' })).toMatch(/claudeFlag/);
    expect(reason({ claudeFlag: 'deepseek/deepseek-v4-flash' })).toBeUndefined();
  });

  it('flags no packaged model', () => {
    for (const [id, m] of Object.entries(defaultModelsConfig.models)) {
      expect(directDeepSeekReason(m), id).toBeUndefined();
    }
  });
});

describe('assertNoDirectDeepSeek (ADR-0163)', () => {
  it('names the entry, ADR and approved intermediaries but not pending ones', () => {
    let message = '';
    try {
      assertNoDirectDeepSeek('my-ds', { envKey: 'DEEPSEEK_API_KEY' });
    } catch (e) {
      message = (e as Error).message;
    }
    for (const s of ['my-ds', 'ADR-0163', 'OpenRouter', 'OpenCode Go']) expect(message).toContain(s);
    expect(message).not.toContain('Azure');
  });

  it('does not throw for an allowed definition', () => {
    expect(() => assertNoDirectDeepSeek('ok', { envKey: null, providerModel: 'openrouter/deepseek/x' })).not.toThrow();
  });
});
