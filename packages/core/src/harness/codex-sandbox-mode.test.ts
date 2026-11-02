import { describe, expect, it } from 'vitest';

import { ModelRegistry } from '../models/index.js';
import type { SandboxPolicy } from '../sandbox/index.js';
import { CodexCliHarness } from './codex-cli.js';
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
    triggers: ['rate_limit', 'unavailable', 'auth'],
    maxRetries: 2,
    cooldownMs: 0,
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

function harnessWith(env: Record<string, string | undefined> = {}) {
  const rec = recordingExec();
  const lines: string[] = [];
  const harness = new CodexCliHarness(rec.fn, {}, { env, log: (line) => lines.push(line) });
  return { rec, lines, harness };
}

describe('CodexCliHarness sandbox mode (#3824)', () => {
  it('defaults to danger-full-access with no workspace-write flags and logs the opt-in', async () => {
    const { rec, lines, harness } = harnessWith();
    const none = { ...sandboxPolicy, runtime: 'none' as const, allowHosts: ['example.com'] };
    const base = { model: 'codex-model', registry, task: 'build_codex' as const };
    await harness.run(makeContractRequest(base)).catch(() => {});
    await harness
      .run(
        makeContractRequest({
          ...base,
          sandbox: none,
          primaryRepoRoot: '/tmp/primary',
          writableRoots: ['/tmp/primary/.factory/state'],
        }),
      )
      .catch(() => {});

    for (const { cmd } of rec.calls) {
      expect(cmd).toContain('--sandbox danger-full-access -c approval_policy=never');
      expect(cmd).not.toContain('sandbox_workspace_write');
      expect(cmd).not.toContain('workspace-write');
    }
    const optIn = lines.filter((l) => l.includes('sandbox.codexSandbox') && l.includes('by default'));
    expect(optIn).toHaveLength(1);
  });

  it('explicit danger-full-access matches the default', async () => {
    const { rec, lines, harness } = harnessWith();
    await harness
      .run(makeContractRequest({ model: 'codex-model', registry, codexSandbox: 'danger-full-access' }))
      .catch(() => {});
    expect(rec.calls[0].cmd).toContain('--sandbox danger-full-access -c approval_policy=never');
    expect(rec.calls[0].cmd).not.toContain('sandbox_workspace_write');
    expect(lines).toContain(
      'codex: --sandbox danger-full-access for task build_codex (sandbox.codexSandbox: danger-full-access)',
    );
  });

  it('workspace-write keeps the network and writable-roots flags', async () => {
    const { rec, harness } = harnessWith();
    const none = { ...sandboxPolicy, runtime: 'none' as const };
    await harness
      .run(
        makeContractRequest({
          model: 'codex-model',
          registry,
          task: 'plan',
          sandbox: none,
          codexSandbox: 'workspace-write',
          primaryRepoRoot: '/tmp/primary',
          writableRoots: ['/tmp/primary/.factory/state'],
        }),
      )
      .catch(() => {});
    const { cmd } = rec.calls[0];
    expect(cmd).toContain('--sandbox workspace-write');
    expect(cmd).toContain('sandbox_workspace_write.network_access');
    expect(cmd).toContain('github.com');
    expect(cmd).toContain('sandbox_workspace_write.writable_roots');
  });

  it('workspace-write still grants a codexFullAccessTasks task full access', async () => {
    const { rec, harness } = harnessWith();
    await harness
      .run(
        makeContractRequest({
          model: 'codex-model',
          registry,
          task: 'build_codex',
          codexSandbox: 'workspace-write',
          codexFullAccessTasks: ['build_codex'],
        }),
      )
      .catch(() => {});
    expect(rec.calls[0].cmd).toContain('--sandbox danger-full-access');
    expect(rec.calls[0].cmd).not.toContain('sandbox_workspace_write');
  });

  it.each([
    ['sandbox-exec', 'sandbox-exec'],
    ['firejail', 'firejail'],
  ] as const)('wraps the default full-access command in the OS sandbox runtime (%s)', async (runtime, wrapper) => {
    const { rec, harness } = harnessWith();
    await harness
      .run(makeContractRequest({ model: 'codex-model', registry, sandbox: { ...sandboxPolicy, runtime } }))
      .catch(() => {});
    expect(rec.calls[0].cmd.startsWith(wrapper)).toBe(true);
    expect(rec.calls[0].cmd).toContain('--sandbox danger-full-access');
  });

  it('logs once that codexFullAccessTasks has no effect under the default', async () => {
    const { lines, harness } = harnessWith();
    const request = makeContractRequest({ model: 'codex-model', registry, codexFullAccessTasks: ['plan'] });
    await harness.run(request).catch(() => {});
    await harness.run(request).catch(() => {});
    expect(lines.filter((l) => l.includes('have no effect while full access is the default'))).toHaveLength(1);
  });

  it('logs once that FACTORY_CODEX_FULL_ACCESS has no effect under the default', async () => {
    const { lines, harness } = harnessWith({ FACTORY_CODEX_FULL_ACCESS: '1' });
    const request = makeContractRequest({ model: 'codex-model', registry });
    await harness.run(request).catch(() => {});
    await harness.run(request).catch(() => {});
    expect(lines.filter((l) => l.includes('FACTORY_CODEX_FULL_ACCESS have no effect'))).toHaveLength(1);
  });

  it('uses the outer wrapper when present and Codex workspace-write for runtime none', async () => {
    const rec = recordingExec();
    const harness = new CodexCliHarness(rec.fn);
    await harness
      .run(
        makeContractRequest({
          model: 'codex-model',
          registry,
          prompt: 'build it',
          sandbox: sandboxPolicy,
          codexSandbox: 'workspace-write',
        }),
      )
      .catch(() => {});
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0].cmd.startsWith('sandbox-exec -p ')).toBe(true);
    expect(rec.calls[0].cmd).toContain('codex exec --json --sandbox workspace-write');
    const none = { ...sandboxPolicy, runtime: 'none' as const, allowHosts: ['example.com'] };
    const request = makeContractRequest({
      model: 'codex-model',
      registry,
      task: 'plan',
      sandbox: none,
      codexSandbox: 'workspace-write',
    });
    await harness.run(request).catch(() => {});
    expect(rec.calls[1].cmd).toMatch(/^codex exec --json --sandbox workspace-write /);
    expect(rec.calls[1].cmd).toContain('-c sandbox_workspace_write.network_access=true');
    expect(rec.calls[1].cmd).toContain('-c features.network_proxy.enabled=true');
    expect(rec.calls[1].cmd).toContain('"example.com"="allow"');
    expect(rec.calls[1].cmd).toContain('"api.github.com"="allow"');
  });
});
