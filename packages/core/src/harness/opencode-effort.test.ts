import { describe, expect, it } from 'vitest';

import type { ModelsConfig } from '../config/index.js';
import { ModelRegistry } from '../models/index.js';
import { makeContractRequest } from './contract.js';
import { buildOpenCodeIsolationArgs, OpenCodeHarness } from './opencode.js';

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
    triggers: ['rate_limit', 'unavailable', 'auth'],
    maxRetries: 2,
    cooldownMs: 0,
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

  describe('--standalone isolation (#2879)', () => {
    const plainRegistry = new ModelRegistry(modelsConfig);
    const plainReq = () => makeContractRequest({ model: 'opencode-model', registry: plainRegistry, prompt: 'x' });

    it('passes --standalone on v2', async () => {
      for (const mk of [req, plainReq]) {
        const rec = versionedExec('2.0.29');
        await new OpenCodeHarness(rec.fn).run(mk());
        expect(rec.runCalls()[0]).toContain('--format json --standalone');
        expect(rec.calls).toContain('opencode --version');
      }
    });

    it('omits --standalone on v1', async () => {
      for (const mk of [req, plainReq]) {
        const rec = versionedExec('1.18.28');
        await new OpenCodeHarness(rec.fn).run(mk());
        expect(rec.runCalls()[0]).not.toContain('--standalone');
        expect(rec.calls).toContain('opencode --version');
      }
    });

    it('omits --standalone and returns output when the version probe fails', async () => {
      for (const version of [new Error('ENOENT'), 'garbage', '']) {
        const rec = versionedExec(version);
        const result = await new OpenCodeHarness(rec.fn).run(plainReq());
        expect(result.output).toBe('RUN OUTPUT');
        expect(rec.calls).toContain('opencode --version');
        expect(rec.runCalls()[0]).not.toContain('--standalone');
      }
      const rec = versionedExec('2.0.29');
      const result = await new OpenCodeHarness(rec.fn, async () => {
        throw new Error('boom');
      }).run(plainReq());
      expect(result.output).toBe('RUN OUTPUT');
      expect(rec.runCalls()[0]).not.toContain('--standalone');
    });

    it('applies --standalone to the final-message retry on v2', async () => {
      const calls: string[] = [];
      const fn = async (cmd: string) => {
        calls.push(cmd);
        if (cmd === 'opencode --version') return { stdout: '2.0.29', stderr: '' };
        return {
          stdout: calls.filter((c) => c.startsWith('opencode run')).length === 1 ? '' : 'RUN OUTPUT',
          stderr: '',
        };
      };
      await new OpenCodeHarness(fn).run(plainReq());
      const runs = calls.filter((c) => c.startsWith('opencode run'));
      expect(runs).toHaveLength(2);
      for (const c of runs) expect(c).toContain('--standalone');
    });

    it('buildOpenCodeIsolationArgs returns the flag only for v2+', () => {
      expect(buildOpenCodeIsolationArgs(2)).toBe('--standalone');
      expect(buildOpenCodeIsolationArgs(1)).toBe('');
      expect(buildOpenCodeIsolationArgs(undefined)).toBe('');
    });
  });
});
