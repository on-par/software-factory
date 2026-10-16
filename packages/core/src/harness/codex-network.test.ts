import { execFileSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { ModelRegistry } from '../models/index.js';
import type { SandboxPolicy } from '../sandbox/index.js';
import { CodexCliHarness, codexNetworkConfigFlags } from './codex-cli.js';
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
  return { fn, calls };
}

/** The host keys of the `features.network_proxy.domains` table in a rendered command, sorted. */
function domainKeys(text: string): string[] {
  const table = text.match(/features\.network_proxy\.domains=\{([^}]*)\}/);
  if (!table) return [];
  return [...table[1].matchAll(/"([^"]*)"="allow"/g)].map((m) => m[1]).sort();
}

describe('codexNetworkConfigFlags', () => {
  it('maps hosts to an allow-only domains table with network access and the proxy on', () => {
    const out = codexNetworkConfigFlags(['registry.npmjs.org', 'registry.yarnpkg.com']);
    expect(out).toContain('-c sandbox_workspace_write.network_access=true');
    expect(out).toContain('-c features.network_proxy.enabled=true');
    expect(domainKeys(out)).toEqual(['registry.npmjs.org', 'registry.yarnpkg.com']);
  });

  it('keeps *.suffix wildcards (dotnet)', () => {
    expect(domainKeys(codexNetworkConfigFlags(['api.nuget.org', '*.nuget.org']))).toEqual([
      '*.nuget.org',
      'api.nuget.org',
    ]);
  });

  it('normalizes case and whitespace and dedupes', () => {
    expect(domainKeys(codexNetworkConfigFlags([' Registry.NPMJS.org ', 'registry.npmjs.org']))).toEqual([
      'registry.npmjs.org',
    ]);
  });

  it('never emits a domain outside the allowlist (drops *, **., host:port, quotes and blanks)', () => {
    const out = codexNetworkConfigFlags([
      'registry.npmjs.org',
      '*',
      '**.evil.com',
      'evil.com:443',
      'a"="allow","evil.com',
      '',
      '  ',
      'x y',
    ]);
    expect(domainKeys(out)).toEqual(['registry.npmjs.org']);
    expect(out).not.toContain('evil');
    expect(out).not.toContain('"*"');
  });

  it('is deny-all for an empty or all-invalid list', () => {
    for (const hosts of [[], ['*']]) {
      const out = codexNetworkConfigFlags(hosts);
      expect(out).toBe('-c sandbox_workspace_write.network_access=false');
      expect(out).not.toContain('network_proxy');
    }
  });

  it.skipIf(process.platform === 'win32')('round-trips through the shell as single argv words', () => {
    const out = execFileSync(
      '/bin/sh',
      ['-c', `printf '%s\\0' ${codexNetworkConfigFlags(['registry.npmjs.org', '*.nuget.org'])}`],
      { encoding: 'utf-8' },
    );
    expect(out.split('\0').slice(0, -1)).toEqual([
      '-c',
      'sandbox_workspace_write.network_access=true',
      '-c',
      'features.network_proxy.enabled=true',
      '-c',
      'features.network_proxy.domains={"registry.npmjs.org"="allow","*.nuget.org"="allow"}',
    ]);
  });
});

describe('CodexCliHarness workspace-write network mapping', () => {
  async function cmdFor(runtime: SandboxPolicy['runtime'], allowHosts: string[]): Promise<string> {
    const rec = recordingExec();
    await new CodexCliHarness(rec.fn)
      .run(
        makeContractRequest({
          model: 'codex-model',
          registry,
          prompt: 'build it',
          sandbox: { ...sandboxPolicy, runtime, allowHosts },
        }),
      )
      .catch(() => {});
    return rec.calls[0].cmd;
  }

  const hosts = ['registry.npmjs.org', 'registry.yarnpkg.com'];

  it('maps the policy allowHosts into exactly the Codex network_proxy domains when codex is its own sandbox', async () => {
    const cmd = await cmdFor('none', hosts);
    expect(
      cmd.startsWith(
        'codex exec --json --sandbox workspace-write -c approval_policy=never -c sandbox_workspace_write.network_access=true -c features.network_proxy.enabled=true',
      ),
    ).toBe(true);
    expect(domainKeys(cmd)).toEqual(hosts);
  });

  it('does the same for docker-sandbox', async () => {
    const cmd = await cmdFor('docker-sandbox', hosts);
    expect(cmd).toContain('-c features.network_proxy.enabled=true');
    expect(domainKeys(cmd)).toEqual(hosts);
  });

  it('keeps codex network off for an empty allowlist', async () => {
    const cmd = await cmdFor('none', []);
    expect(cmd).toContain('-c sandbox_workspace_write.network_access=false');
    expect(cmd).not.toContain('network_proxy');
  });

  it('leaves sandbox-exec and firejail commands unchanged', async () => {
    for (const runtime of ['sandbox-exec', 'firejail'] as const) {
      const cmd = await cmdFor(runtime, ['registry.npmjs.org']);
      expect(cmd).not.toContain('network_access');
      expect(cmd).not.toContain('network_proxy');
    }
  });
});
