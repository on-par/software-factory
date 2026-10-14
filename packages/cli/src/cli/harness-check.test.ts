// packages/cli/src/cli/harness-check.test.ts — factory harness check <id> (#2875)

import type { ModelsConfig } from '@on-par/factory-core';
import type { HarnessCheckResult } from '@on-par/factory-core/internal';
import { describe, expect, it, vi } from 'vitest';

import { formatHarnessCheckLine, type HarnessCheckCommandDeps, runHarnessCheckCommand } from './harness-check.js';

const decl = { command: 'my-agent', prompt: 'stdin', output: 'stdout', agentic: false, usage: 'none' } as const;

function modelDef(harness?: string): ModelsConfig['models'][string] {
  return {
    provider: 'custom',
    tier: 'boss',
    costPerMtokInput: 0,
    costPerMtokOutput: 0,
    contextWindow: 1000,
    capabilities: [],
    envKey: null,
    ...(harness ? { harness } : {}),
  };
}

function config(models: Record<string, ReturnType<typeof modelDef>>): ModelsConfig {
  return {
    version: 1,
    models,
    tiers: { boss: Object.keys(models) },
    failover: {
      triggers: ['rate_limit', 'usage_cap', 'timeout', 'error', 'empty_response'],
      maxRetries: 2,
      cooldownMs: 0,
      escalateAfterTierExhausted: true,
    },
    routingRules: {},
    harnesses: { 'my-agent': decl },
  };
}

const pass: HarnessCheckResult = { name: 'case a', ok: true, rule: 'r', fix: 'f' };
const fail: HarnessCheckResult = {
  name: 'resolves with non-empty output on success',
  ok: false,
  rule: 'non-empty output (docs/harness-contract.md#outputs-harnessresult)',
  fix: 'set output: under harnesses.my-agent',
  error: 'empty_response: no output',
};

function setup(models: ModelsConfig, results: HarnessCheckResult[] = [pass]) {
  const lines: string[] = [];
  const runHarnessCheck = vi.fn(async () => results);
  const deps: HarnessCheckCommandDeps = {
    repoRoot: '/repo',
    loadModelsConfig: () => models,
    loadRepoConfig: () => null,
    applyRepoConfig: (m) => m,
    runHarnessCheck,
    log: (l) => lines.push(l),
  };
  return { lines, runHarnessCheck, deps };
}

describe('runHarnessCheckCommand', () => {
  it('prints PASS for every case and returns 0 for a conforming harness', async () => {
    const { lines, deps } = setup(config({ m1: modelDef('my-agent') }), [pass, { ...pass, name: 'case b' }]);
    expect(await runHarnessCheckCommand('my-agent', {}, deps)).toBe(0);
    expect(lines.slice(0, 2).every((l) => l.startsWith('PASS'))).toBe(true);
    expect(lines.at(-1)).toBe('2/2 cases passed');
  });

  it('returns 1 and prints the FAIL line with rule and fix', async () => {
    const { lines, deps } = setup(config({ m1: modelDef('my-agent') }), [fail]);
    expect(await runHarnessCheckCommand('my-agent', {}, deps)).toBe(1);
    expect(lines[0]).toBe(formatHarnessCheckLine(fail));
    expect(lines[0]).toMatch(
      /^FAIL resolves with non-empty output on success: empty_response: .* \| rule: non-empty output .* \| fix: .*output:/,
    );
  });

  it('unknown id prints no declared harness with the declared ids and returns 1', async () => {
    const { lines, runHarnessCheck, deps } = setup(config({ m1: modelDef('my-agent') }));
    expect(await runHarnessCheckCommand('nope', {}, deps)).toBe(1);
    expect(lines).toEqual(["no declared harness 'nope' (declared: my-agent)"]);
    expect(runHarnessCheck).not.toHaveBeenCalled();
  });

  it('no registry model on the harness returns 1 asking for a model', async () => {
    const { lines, runHarnessCheck, deps } = setup(config({ m1: modelDef() }));
    expect(await runHarnessCheckCommand('my-agent', {}, deps)).toBe(1);
    expect(lines[0]).toContain("needs a model on 'my-agent'");
    expect(runHarnessCheck).not.toHaveBeenCalled();
  });

  it('--model on another harness returns 1', async () => {
    const { lines, deps } = setup(config({ m1: modelDef('my-agent'), m2: modelDef() }));
    expect(await runHarnessCheckCommand('my-agent', { model: 'm2' }, deps)).toBe(1);
    expect(lines).toEqual(["model 'm2' does not run on harness 'my-agent'"]);
  });

  it('unknown --model returns 1', async () => {
    const { lines, deps } = setup(config({ m1: modelDef('my-agent') }));
    expect(await runHarnessCheckCommand('my-agent', { model: 'zz' }, deps)).toBe(1);
    expect(lines).toEqual(["unknown model 'zz'"]);
  });

  it('default model is the first entry on the harness; --no-injection is forwarded', async () => {
    const { runHarnessCheck, deps } = setup(
      config({ m0: modelDef(), m1: modelDef('my-agent'), m2: modelDef('my-agent') }),
    );
    await runHarnessCheckCommand('my-agent', { injection: false }, deps);
    expect(runHarnessCheck).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'm1', injection: false, id: 'my-agent' }),
    );
  });

  it('a config load error is reported and returns 1', async () => {
    const { lines, deps } = setup(config({}));
    deps.loadRepoConfig = () => {
      throw new Error('bad yaml');
    };
    expect(await runHarnessCheckCommand('my-agent', {}, deps)).toBe(1);
    expect(lines).toEqual(['factory harness check: bad yaml']);
  });
});
