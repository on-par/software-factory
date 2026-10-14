import { describe, expect, it } from 'vitest';

import type { ModelsConfig } from '../config/index.js';
import { ModelRegistry } from '../models/index.js';
import { makeContractRequest } from './contract.js';
import { OpenCodeHarness } from './opencode.js';

const modelsConfig: ModelsConfig = {
  version: 1,
  models: {
    'opencode-model': {
      provider: 'custom',
      tier: 'boss',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
      harness: 'opencode',
      providerModel: 'anthropic/claude-sonnet-5',
    },
    'opencode-no-provider-model': {
      provider: 'custom',
      tier: 'boss',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
      harness: 'opencode',
    },
  },
  tiers: { boss: ['opencode-model', 'opencode-no-provider-model'] },
  failover: {
    triggers: ['rate_limit', 'usage_cap', 'timeout', 'error', 'empty_response'],
    maxRetries: 2,
    cooldownMs: 0,
    escalateAfterTierExhausted: true,
  },
  routingRules: {},
};

describe('OpenCodeHarness effort by OpenCode version', () => {
  const effortRegistry = new ModelRegistry({
    ...modelsConfig,
    efforts: { 'opencode-model': 'high', 'opencode-no-provider-model': 'high' },
  });

  function versionedExec(version: string | Error) {
    const calls: string[] = [];
    const fn = async (cmd: string) => {
      calls.push(cmd);
      if (cmd === 'opencode --version') {
        if (version instanceof Error) throw version;
        return { stdout: version, stderr: '' };
      }
      return { stdout: 'RUN OUTPUT', stderr: '' };
    };
    return { fn, calls, runCalls: () => calls.filter((c) => c.startsWith('opencode run')) };
  }

  const req = (model = 'opencode-model') => makeContractRequest({ model, registry: effortRegistry, prompt: 'x' });

  it('passes effort as a #variant model suffix on v2', async () => {
    const rec = versionedExec('2.0.29');
    await new OpenCodeHarness(rec.fn).run(req());
    expect(rec.runCalls()).toHaveLength(1);
    expect(rec.runCalls()[0]).toContain("--model 'anthropic/claude-sonnet-5#high'");
    expect(rec.runCalls()[0]).not.toContain('--variant');
  });

  it('keeps --variant on v1', async () => {
    const rec = versionedExec('1.18.28');
    await new OpenCodeHarness(rec.fn).run(req());
    expect(rec.runCalls()).toHaveLength(1);
    expect(rec.runCalls()[0]).toContain("--model 'anthropic/claude-sonnet-5' --variant 'high'");
  });

  it('probes opencode --version once across two runs', async () => {
    const rec = versionedExec('2.0.29');
    const harness = new OpenCodeHarness(rec.fn);
    await harness.run(req());
    await harness.run(req());
    expect(rec.calls.filter((c) => c === 'opencode --version')).toHaveLength(1);
    expect(rec.runCalls()).toHaveLength(2);
  });

  it('falls back to --variant when the version probe throws or prints no semver', async () => {
    for (const version of [new Error('ENOENT'), 'garbage']) {
      const rec = versionedExec(version);
      const result = await new OpenCodeHarness(rec.fn).run(req());
      expect(result.output).toBe('RUN OUTPUT');
      expect(rec.runCalls()).toHaveLength(1);
      expect(rec.runCalls()[0]).toContain("--variant 'high'");
    }
  });

  it('falls back to --variant when an injected probe rejects', async () => {
    const rec = versionedExec('2.0.29');
    await new OpenCodeHarness(rec.fn, async () => {
      throw new Error('boom');
    }).run(req());
    expect(rec.runCalls()[0]).toContain("--variant 'high'");
  });

  it('omits effort on v2 when there is no providerModel', async () => {
    const rec = versionedExec('2.0.29');
    await new OpenCodeHarness(rec.fn).run(req('opencode-no-provider-model'));
    expect(rec.runCalls()).toHaveLength(1);
    expect(rec.runCalls()[0]).not.toContain('--model');
    expect(rec.runCalls()[0]).not.toContain('--variant');
  });
});
