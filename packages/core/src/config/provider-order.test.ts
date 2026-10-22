import { defaultModelsConfig } from '@on-par/factory-config';
import { describe, expect, it } from 'vitest';

import {
  deriveProviderOrder,
  isOpenCodeZenModel,
  providerOrderIssues,
  resolveRoleModel,
  subscriptionProviderOf,
  type ProviderOrder,
} from './provider-order.js';

const models = defaultModelsConfig.models;

describe('resolveRoleModel', () => {
  const order: ProviderOrder = {
    ...defaultModelsConfig.providerOrder,
    checker: ['claude-sonnet-5', 'gpt-5.6-luna-high'],
  };

  it("returns the role's model for the provider and never another provider's", () => {
    expect(resolveRoleModel(order, 'checker', 'codex')).toBe('gpt-5.6-luna-high');
    expect(resolveRoleModel(order, 'checker', 'claude')).toBe('claude-sonnet-5');
    expect(resolveRoleModel(order, 'checker', 'opencode-go')).toBeUndefined();
  });
});

describe('deriveProviderOrder', () => {
  it('equals the packaged providerOrder literal (drift guard)', () => {
    expect(deriveProviderOrder(defaultModelsConfig.tiers, models)).toEqual(defaultModelsConfig.providerOrder);
  });

  it('treats a missing tier as just the opencode-go slot', () => {
    expect(deriveProviderOrder({}, models).worker).toEqual(['opencode-deepseek-v4-flash']);
  });
});

describe('classification', () => {
  it('flags opencode/ ids and providerModels as Zen but not opencode-go/', () => {
    expect(isOpenCodeZenModel('opencode/x')).toBe(true);
    expect(isOpenCodeZenModel('m', { providerModel: 'opencode/x' })).toBe(true);
    expect(isOpenCodeZenModel('opencode-deepseek-v4-flash', models['opencode-deepseek-v4-flash'])).toBe(false);
  });

  it('maps subscription harnesses and leaves the rest undefined', () => {
    expect(subscriptionProviderOf('claude-sonnet-5', models['claude-sonnet-5'])).toBe('claude');
    expect(subscriptionProviderOf('gpt-5.6-luna-high', models['gpt-5.6-luna-high'])).toBe('codex');
    expect(subscriptionProviderOf('opencode-deepseek-v4-flash', models['opencode-deepseek-v4-flash'])).toBe(
      'opencode-go',
    );
    expect(subscriptionProviderOf('opencode-sonnet', models['opencode-sonnet'])).toBeUndefined();
    expect(subscriptionProviderOf('qwen3:8b', models['qwen3:8b'])).toBeUndefined();
    expect(subscriptionProviderOf('x', undefined)).toBeUndefined();
    for (const [id, def] of Object.entries(models)) {
      if (def.endpoint) expect(subscriptionProviderOf(id, def)).toBeUndefined();
    }
  });
});

describe('providerOrderIssues', () => {
  const messages = (worker: string[]) => providerOrderIssues({ worker }, models).map((i) => i.message);

  it('accepts the packaged order', () => {
    expect(providerOrderIssues(defaultModelsConfig.providerOrder, models)).toEqual([]);
  });

  it('reports Zen, unknown, non-subscription, duplicate-provider and empty cases', () => {
    expect(messages(['opencode/claude-sonnet-5'])[0]).toMatch(/worker\[0\].*OpenCode Zen/);
    expect(messages(['nope'])[0]).toMatch(/worker\[0\]: unknown model 'nope'/);
    expect(messages(['qwen3:8b'])[0]).toMatch(/not a subscription CLI model/);
    expect(messages(['gpt-5.6-terra-medium', 'gpt-5.6-sol'])[0]).toMatch(/worker\[1\].*second codex model/);
    expect(messages([])).toEqual(['models.providerOrder.worker: list at least one model']);
  });
});
