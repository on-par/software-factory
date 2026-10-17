import { describe, expect, it, vi } from 'vitest';

import { ModelRegistry } from '../models/index.js';
import type { SandboxPolicy } from '../sandbox/index.js';
import { CodexCliHarness, codexFullAccessOptIn } from './codex-cli.js';
import { makeContractRequest } from './contract.js';

const sandboxPolicy: SandboxPolicy = {
  runtime: 'sandbox-exec',
  worktree: '/tmp/factory worktree',
  writablePaths: ['/tmp/factory worktree'],
  writableFilePrefixes: [],
  allowHosts: [],
  cpuMs: 300_000,
  memMb: 4096,
};

const registry = new ModelRegistry({
  version: 1,
  models: {
    'codex-model': {
      provider: 'openai',
      tier: 'boss',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
      codex: true,
      codexFlag: '--model gpt-5-codex',
    },
  },
  tiers: { boss: ['codex-model'] },
  failover: {
    triggers: ['rate_limit', 'usage_cap', 'timeout', 'error', 'empty_response'],
    maxRetries: 2,
    cooldownMs: 0,
    escalateAfterTierExhausted: true,
  },
  routingRules: {},
});

function recordingExec() {
  const calls: { cmd: string }[] = [];
  const fn = async (cmd: string) => {
    calls.push({ cmd });
    return { stdout: '', stderr: '' };
  };
  return { calls, fn };
}

describe('CodexCliHarness full-access opt-in (#3080)', () => {
  it('uses danger-full-access without a preflight and logs it when the operator opts in', async () => {
    const rec = recordingExec();
    const lines: string[] = [];
    const harness = new CodexCliHarness(
      rec.fn,
      {},
      { env: { FACTORY_CODEX_FULL_ACCESS: '1' }, log: (l) => lines.push(l) },
    );
    const request = makeContractRequest({ model: 'codex-model', registry, sandbox: sandboxPolicy });

    await harness.run(request).catch(() => {});
    await harness.run(request).catch(() => {});

    expect(rec.calls).toHaveLength(2);
    expect(rec.calls[0].cmd).toContain('--sandbox danger-full-access');
    expect(rec.calls[0].cmd).not.toContain('workspace-write');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/operator opted in/);
    expect(lines[0]).toContain('FACTORY_CODEX_FULL_ACCESS');
  });

  it('emits no network config flags under the opt-in with a non-wrapper runtime', async () => {
    const rec = recordingExec();
    const harness = new CodexCliHarness(rec.fn, {}, { env: { FACTORY_CODEX_FULL_ACCESS: 'true' }, log: () => {} });

    await harness
      .run(
        makeContractRequest({
          model: 'codex-model',
          registry,
          sandbox: { ...sandboxPolicy, runtime: 'none', allowHosts: ['example.com'] },
        }),
      )
      .catch(() => {});

    expect(rec.calls[0].cmd).toContain('--sandbox danger-full-access');
    expect(rec.calls[0].cmd).not.toContain('sandbox_workspace_write.network_access');
  });

  it("keeps today's command and logs nothing when the opt-in is unset", async () => {
    const rec = recordingExec();
    const log = vi.fn();
    const harness = new CodexCliHarness(rec.fn, {}, { env: {}, log });

    await harness.run(makeContractRequest({ model: 'codex-model', registry })).catch(() => {});
    await harness.run(makeContractRequest({ model: 'codex-model', registry, sandbox: sandboxPolicy })).catch(() => {});

    expect(rec.calls[0].cmd).toContain('--sandbox danger-full-access');
    expect(rec.calls[1].cmd).toContain('--sandbox workspace-write');
    expect(log).not.toHaveBeenCalled();
  });
});

describe('codexFullAccessOptIn', () => {
  it.each([
    ['1', true],
    ['true', true],
    [' TRUE ', true],
    [undefined, false],
    ['', false],
    ['0', false],
    ['false', false],
    ['yes', false],
  ])('FACTORY_CODEX_FULL_ACCESS=%j -> %s', (value, expected) => {
    expect(codexFullAccessOptIn({ FACTORY_CODEX_FULL_ACCESS: value })).toBe(expected);
  });
});
