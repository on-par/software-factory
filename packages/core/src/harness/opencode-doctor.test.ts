import { describe, expect, it } from 'vitest';

import type { ModelsConfig } from '../config/index.js';
import { diagnoseModels, ModelRegistry } from '../models/index.js';

const modelsConfig: ModelsConfig = {
  version: 1,
  models: {},
  tiers: { worker: ['keyed-model', 'keyed-model-2', 'keyless-model'] },
  failover: { triggers: ['auth'], maxRetries: 1, cooldownMs: 0 },
  routingRules: {},
};

describe('OpenCode doctor auth probe', () => {
  const def = {
    provider: 'custom' as const,
    tier: 'worker' as const,
    costPerMtokInput: 0,
    costPerMtokOutput: 0,
    contextWindow: 1000,
    capabilities: [],
    harness: 'opencode',
    providerModel: 'opencode-go/deepseek-v4-flash',
  };
  const doctorConfig: ModelsConfig = {
    ...modelsConfig,
    models: {
      'keyed-model': { ...def, envKey: 'OPENCODE_API_KEY' },
      'keyed-model-2': { ...def, envKey: 'OPENCODE_API_KEY' },
      'keyless-model': { ...def, envKey: null },
    },
  };
  const doctorRegistry = new ModelRegistry(doctorConfig);
  const beforeReview = () => new Date('2026-10-01T00:00:00Z');
  const diagnose = (id: string, p: Parameters<typeof diagnoseModels>[1], probes = { now: beforeReview, ...p }) =>
    diagnoseModels(new ModelRegistry({ ...doctorConfig, models: { [id]: doctorConfig.models[id] } }), probes, true)[0];
  const hasOpencode = (cmd: string) => cmd === 'opencode';

  it('reports an OPENCODE_API_KEY model reachable when opencode is logged in and the key is unset', () => {
    const d = diagnose('keyed-model', {
      commandAvailable: hasOpencode,
      envPresent: () => false,
      opencodeLoggedIn: () => true,
    });
    expect(d.reachable).toBe(true);
    expect(d.reason).toBe('ok (opencode CLI auth; OPENCODE_API_KEY not set)');
  });

  it('reports an OPENCODE_API_KEY model reachable via the key override when opencode is not logged in, without consulting the login probe', () => {
    let probes = 0;
    const opencodeLoggedIn = () => {
      probes++;
      return false;
    };
    const d = diagnose('keyed-model', {
      commandAvailable: hasOpencode,
      envPresent: (k) => k === 'OPENCODE_API_KEY',
      opencodeLoggedIn,
    });
    expect(d.reachable).toBe(true);
    expect(d.reason).toBe('ok (opencode CLI)');
    expect(probes).toBe(0);
  });

  it('marks the model unverified when neither logged in nor keyed', () => {
    const d = diagnose('keyed-model', {
      commandAvailable: hasOpencode,
      envPresent: () => false,
      opencodeLoggedIn: () => false,
    });
    expect(d.reachable).toBe(false);
    expect(d.unverified).toBe(true);
    expect(d.reason).toContain('opencode auth login');
    expect(d.reason).toContain('OPENCODE_API_KEY');
  });

  it('keeps an envKey-less model reachable without consulting the login probe', () => {
    let probes = 0;
    const opencodeLoggedIn = () => {
      probes++;
      return false;
    };
    const d = diagnose('keyless-model', { commandAvailable: hasOpencode, envPresent: () => false, opencodeLoggedIn });
    expect(d.reachable).toBe(true);
    expect(d.reason).toBe('ok (opencode CLI)');
    expect(probes).toBe(0);
  });

  it('reports a missing opencode CLI without consulting the login probe', () => {
    let probes = 0;
    const opencodeLoggedIn = () => {
      probes++;
      return true;
    };
    const d = diagnose('keyed-model', { commandAvailable: () => false, envPresent: () => false, opencodeLoggedIn });
    expect(d.reachable).toBe(false);
    expect(d.reason).toBe('opencode CLI not found on PATH');
    expect(probes).toBe(0);
  });

  it('treats a throwing login probe as not logged in and probes at most once', () => {
    let probes = 0;
    const opencodeLoggedIn = (): boolean => {
      probes++;
      throw new Error('boom');
    };
    const diags = diagnoseModels(
      doctorRegistry,
      { commandAvailable: hasOpencode, envPresent: () => false, opencodeLoggedIn, now: beforeReview },
      true,
    ).filter((d) => d.model.startsWith('keyed-model'));
    expect(diags).toHaveLength(2);
    for (const d of diags) expect(d.unverified).toBe(true);
    expect(probes).toBe(1);
  });
});
