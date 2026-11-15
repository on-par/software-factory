import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { defaultModelsConfig } from '@on-par/factory-config';
import { afterEach, describe, expect, it } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';
import { resolveRoleModel, type ProviderOrder } from '../config/provider-order.js';
import { filterRefusedProviders, subscriptionLogin, type SubscriptionLoginDeps } from './subscription-login.js';

const models = defaultModelsConfig.models;
const order = defaultModelsConfig.providerOrder as ProviderOrder;
const NOW = Date.parse('2026-10-20T12:00:00Z');
const tempDirs = createTempDirs();

function codexHome(auth: unknown): string {
  const dir = tempDirs.makeSync('codex-home-');
  if (auth !== undefined) writeFileSync(join(dir, 'auth.json'), JSON.stringify(auth));
  return dir;
}

const chatgptAuth = { tokens: { refresh_token: 'rt' } };

function harness(env: NodeJS.ProcessEnv, failExec: readonly string[] = []) {
  const execs: string[] = [];
  const logs: Array<{ type: string; msg: string; extra?: unknown }> = [];
  const deps: SubscriptionLoginDeps = {
    env,
    platform: 'darwin',
    exec: (file: string) => {
      execs.push(file);
      if (failExec.includes(file)) throw new Error('not signed in');
    },
    fileExists: () => true,
    now: () => NOW,
    log: (type: string, msg: string, extra?: unknown) => void logs.push({ type, msg, extra }),
    logged: new Set(),
  };
  return { execs, logs, deps };
}

afterEach(async () => {
  await tempDirs.cleanup();
});

describe('subscriptionLogin', () => {
  it('opencode-go is a subscription', () => {
    expect(subscriptionLogin('opencode-go', harness({}).deps)).toBe('subscription');
  });

  it('claude follows the plan detector', () => {
    expect(subscriptionLogin('claude', harness({ ANTHROPIC_API_KEY: 'sk-ant' }).deps)).toBe('api');
  });
});

describe('filterRefusedProviders (#3335)', () => {
  it('an API-key login is refused for failover like the bench harness (2026-10-20)', () => {
    const { execs, logs, deps } = harness({ CODEX_HOME: codexHome({ OPENAI_API_KEY: 'sk-test' }) });
    expect(subscriptionLogin('codex', deps)).toBe('api');
    const { order: filtered, refused } = filterRefusedProviders(order, models, deps);
    for (const role of ['boss', 'worker', 'checker', 'triage'] as const) {
      expect(filtered[role].some((id) => models[id]?.harness === 'codex-cli')).toBe(false);
    }
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ provider: 'codex', login: 'api' });
    expect(logs).toEqual([
      {
        type: 'provider_refused',
        msg: expect.any(String),
        extra: { providerRefused: { provider: 'codex', login: 'api', at: new Date(NOW).toISOString() } },
      },
    ]);
    expect(execs).not.toContain('codex');
    expect(JSON.stringify(logs)).not.toContain('sk-test');
  });

  it('a Claude API-key login drops claude so the boss order starts on codex and no claude command runs', () => {
    const { execs, deps } = harness({ ANTHROPIC_API_KEY: 'sk-ant', CODEX_HOME: codexHome(chatgptAuth) });
    const { order: filtered, refused } = filterRefusedProviders(order, models, deps);
    expect(filtered.boss[0]).toBe('gpt-5.6-terra-high');
    expect(resolveRoleModel(filtered, 'boss', 'claude')).toBeUndefined();
    expect(refused).toMatchObject([{ provider: 'claude', login: 'api' }]);
    expect(execs.filter((f) => f === 'claude' || f === 'security')).toEqual([]);
  });

  it('subscription logins with opencode-go/ models are kept and nothing is logged', () => {
    const { logs, deps } = harness({ OPENCODE_API_KEY: 'k', CODEX_HOME: codexHome(chatgptAuth) });
    const result = filterRefusedProviders(order, models, deps);
    expect(result.order).toEqual(order);
    expect(result.refused).toEqual([]);
    expect(logs).toEqual([]);
  });

  it('logs provider_refused once per process per provider', () => {
    const { logs, deps } = harness({ CODEX_HOME: codexHome({ OPENAI_API_KEY: 'sk-test' }) });
    filterRefusedProviders(order, models, deps);
    filterRefusedProviders(order, models, deps);
    expect(logs).toHaveLength(1);
  });

  it('an unknown login is refused', () => {
    const { deps } = harness({ CODEX_HOME: codexHome(undefined) }, ['codex']);
    expect(subscriptionLogin('codex', deps)).toBe('unknown');
    const { refused } = filterRefusedProviders(order, models, deps);
    expect(refused).toMatchObject([{ provider: 'codex', login: 'unknown' }]);
  });

  it('an opencode model that is not opencode-go/ is refused', () => {
    const { deps } = harness({ CODEX_HOME: codexHome(chatgptAuth) });
    const zen = { ...models, zen: { harness: 'opencode', providerModel: 'opencode/foo' } };
    const input = { ...order, triage: ['zen'] };
    const { order: filtered, refused } = filterRefusedProviders(input, zen, deps);
    expect(filtered.triage).toEqual([]);
    expect(refused).toEqual([{ provider: 'opencode-go', login: 'api', models: ['zen'] }]);
  });

  it('drops an id with no registry entry and does not mutate its input', () => {
    const { deps } = harness({ CODEX_HOME: codexHome(chatgptAuth) });
    const input: ProviderOrder = { ...order, boss: ['ghost', ...order.boss] };
    const snapshot = structuredClone(input);
    const { order: filtered, refused } = filterRefusedProviders(input, models, deps);
    expect(input).toEqual(snapshot);
    expect(filtered.boss).toEqual(order.boss);
    expect(refused).toMatchObject([{ provider: 'ghost', login: 'unknown' }]);
  });
});
