// src/harness/check.test.ts — runHarnessCheck against real fixture scripts (#2875)

import { existsSync } from 'node:fs';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { HarnessDeclaration, ModelsConfig } from '../config/index.js';
import { ModelRegistry } from '../models/index.js';
import type { ExecFn } from '../utils/exec.js';
import { defaultExecFn } from '../utils/exec.js';
import { harnessCheckRule, runHarnessCheck } from './check.js';
import { codingHarnessContractCases } from './contract.js';

let tmp: string;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'check-test-'));
  await writeFile(join(tmp, 'ok.sh'), '#!/bin/sh\ncat >/dev/null\necho ok\n');
  await writeFile(join(tmp, 'silent.sh'), '#!/bin/sh\ncat >/dev/null\nexit 0\n');
  await chmod(join(tmp, 'ok.sh'), 0o755);
  await chmod(join(tmp, 'silent.sh'), 0o755);
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function decl(script: string): HarnessDeclaration {
  return { command: join(tmp, script), prompt: 'stdin', output: 'stdout', agentic: false, usage: 'none' };
}

function registryFor(declaration: HarnessDeclaration): ModelRegistry {
  const config: ModelsConfig = {
    version: 1,
    models: {
      'my-model': {
        provider: 'custom',
        tier: 'boss',
        costPerMtokInput: 0,
        costPerMtokOutput: 0,
        contextWindow: 1000,
        capabilities: [],
        envKey: null,
        harness: 'my-agent',
      },
    },
    tiers: { boss: ['my-model'] },
    failover: {
      triggers: ['rate_limit', 'usage_cap', 'timeout', 'error', 'empty_response'],
      maxRetries: 2,
      cooldownMs: 0,
      escalateAfterTierExhausted: true,
    },
    routingRules: {},
    harnesses: { 'my-agent': declaration },
  };
  return new ModelRegistry(config);
}

describe('runHarnessCheck', () => {
  it('every case passes for a command that prints ok', async () => {
    const declaration = decl('ok.sh');
    const results = await runHarnessCheck({
      id: 'my-agent',
      declaration,
      model: 'my-model',
      registry: registryFor(declaration),
    });
    const kitCount = codingHarnessContractCases({
      success: () => {
        throw new Error('unused');
      },
      timeout: () => {
        throw new Error('unused');
      },
      emptyOutput: () => {
        throw new Error('unused');
      },
      failure: () => {
        throw new Error('unused');
      },
    }).length;
    expect(results).toHaveLength(kitCount);
    expect(results.filter((r) => !r.ok)).toEqual([]);
  });

  it('empty output fails the success case with empty_response and an output: fix', async () => {
    const declaration = decl('silent.sh');
    const results = await runHarnessCheck({
      id: 'my-agent',
      declaration,
      model: 'my-model',
      registry: registryFor(declaration),
      injection: false,
    });
    const success = results.find((r) => r.name === 'resolves with non-empty output on success');
    expect(success?.ok).toBe(false);
    expect(success?.error).toContain('empty_response');
    expect(success?.rule).toContain('non-empty output');
    expect(success?.fix).toContain('output:');
    const empty = results.find((r) => r.name.includes('empty_response on empty output'));
    expect(empty?.ok).toBe(true);
  });

  it('injection false drops injection cases', async () => {
    const declaration = decl('ok.sh');
    const common = { id: 'my-agent', declaration, model: 'my-model', registry: registryFor(declaration) };
    const withInjection = await runHarnessCheck(common);
    const without = await runHarnessCheck({ ...common, injection: false });
    expect(withInjection.some((r) => r.name.startsWith('handles injected instruction'))).toBe(true);
    expect(without.some((r) => r.name.startsWith('handles injected instruction'))).toBe(false);
  });

  it('removes the scratch dir', async () => {
    const declaration = decl('ok.sh');
    const cwds: string[] = [];
    const execFn: ExecFn = (cmd, o) => {
      if (o.cwd) cwds.push(o.cwd);
      return defaultExecFn(cmd, o);
    };
    await runHarnessCheck({
      id: 'my-agent',
      declaration,
      model: 'my-model',
      registry: registryFor(declaration),
      injection: false,
      execFn,
    });
    expect(cwds.length).toBeGreaterThan(0);
    expect(cwds.every((d) => !existsSync(d))).toBe(true);
  });
});

describe('harnessCheckRule', () => {
  it('falls back for an unknown case name', () => {
    expect(harnessCheckRule('some future case', 'x')).toEqual({
      rule: 'contract (docs/harness-contract.md)',
      fix: 'see docs/harness-contract.md',
    });
  });

  it('maps injection cases by prefix', () => {
    expect(harnessCheckRule('handles injected instruction without following it: a', 'x').rule).toContain('injection');
  });
});
