import { existsSync } from 'node:fs';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { HarnessDeclaration, ModelsConfig } from '../config/index.js';
import { ModelRegistry } from '../models/index.js';
import { defaultExecFn } from '../utils/exec.js';
import type { ExecFn } from '../utils/exec.js';
import { HARNESS_CHECK_RULES, ruleFor, runHarnessCheck } from './check.js';
import { CommandHarness } from './command.js';
import type { HarnessContractScenarios } from './contract.js';
import { codingHarnessContractCases } from './contract.js';

const CONFIG: ModelsConfig = {
  version: 1,
  models: {
    'fx-model': {
      provider: 'custom',
      tier: 'worker',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
      harness: 'my-agent',
    },
  },
  tiers: { worker: ['fx-model'] },
  failover: { triggers: [], maxRetries: 0, cooldownMs: 0, escalateAfterTierExhausted: false },
  routingRules: {},
  harnesses: {},
};

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'check-test-'));
  const script = (name: string, body: string) => {
    const p = join(dir, name);
    writeFileSync(p, `#!/bin/sh\n${body}\n`);
    chmodSync(p, 0o755);
    return p;
  };
  script('ok.sh', 'echo ok');
  script('silent.sh', 'exit 0');
  script('slow.sh', 'sleep 5; echo ok');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function decl(script: string): HarnessDeclaration {
  return {
    command: join(dir, script),
    prompt: 'stdin',
    output: 'stdout',
    agentic: false,
    usage: 'none',
  };
}

const UNUSED: HarnessContractScenarios = {
  success: () => ({ harness: new CommandHarness('x', decl('ok.sh'), defaultExecFn) }),
  timeout: () => ({ harness: new CommandHarness('x', decl('ok.sh'), defaultExecFn) }),
  emptyOutput: () => ({ harness: new CommandHarness('x', decl('ok.sh'), defaultExecFn) }),
  failure: () => ({ harness: new CommandHarness('x', decl('ok.sh'), defaultExecFn) }),
};

const registry = new ModelRegistry(CONFIG);
const base = { id: 'my-agent', model: 'fx-model', registry };

describe('runHarnessCheck', () => {
  it('passes every case, injection cases included, for a conforming script', async () => {
    const results = await runHarnessCheck({ ...base, declaration: decl('ok.sh') });
    const expected = codingHarnessContractCases(UNUSED).length;
    expect(results).toHaveLength(expected);
    expect(results.filter((r) => !r.ok)).toEqual([]);
  });

  it('explains a silent command on the success case; the substituted cases still pass', async () => {
    const results = await runHarnessCheck({ ...base, declaration: decl('silent.sh') });
    const failed = results.filter((r) => !r.ok);
    expect(failed.map((r) => r.name)).toContain('resolves with non-empty output on success');
    const success = failed.find((r) => r.name === 'resolves with non-empty output on success');
    expect(success?.error).toContain('empty_response');
    expect(success?.rule).toContain('non-empty output');
    expect(success?.fix).toContain('output:');
    for (const name of [
      'rejects with HarnessError reason empty_response on empty output',
      'rejects with a classified reason on nonzero failure',
    ]) {
      expect(results.find((r) => r.name === name)?.ok).toBe(true);
    }
  });

  it('passes the timeout case for a slow script', async () => {
    const results = await runHarnessCheck({ ...base, declaration: decl('slow.sh') });
    expect(results.find((r) => r.name === 'rejects with HarnessError reason timeout on timeout')?.ok).toBe(true);
  });

  it('maps every kit case name to a docs/harness-contract.md rule', async () => {
    const results = await runHarnessCheck({ ...base, declaration: decl('ok.sh') });
    for (const r of results) expect(r.rule).toContain('docs/harness-contract.md');
    expect(Object.keys(HARNESS_CHECK_RULES).length).toBeGreaterThan(0);
  });

  it('falls back for an unmapped case name', () => {
    expect(ruleFor('no such case')).toEqual({
      rule: 'docs/harness-contract.md',
      fix: 'See docs/harness-contract.md for this case.',
    });
  });

  it('removes the scratch dir afterwards', async () => {
    let cwd: string | undefined;
    const execFn: ExecFn = (cmd, o) => {
      cwd ??= o.cwd;
      return defaultExecFn(cmd, o);
    };
    await runHarnessCheck({ ...base, declaration: decl('ok.sh'), execFn });
    expect(cwd).toBeDefined();
    expect(existsSync(cwd as string)).toBe(false);
  });
});
