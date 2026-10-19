import { execFileSync } from 'node:child_process';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ModelRegistry } from '../models/index.js';
import type { SandboxPolicy } from '../sandbox/index.js';
import type { TaskType } from '../types/index.js';
import { CodexCliHarness } from './codex-cli.js';
import { CODEX_GITHUB_HOSTS, CODEX_GITHUB_NETWORK_TASKS } from './codex-policy.js';
import { makeContractRequest } from './contract.js';

const repo = '/tmp/primary repo';
const worktree = '/tmp/issue worktree';
const state = join(repo, '.factory/state');
const registry = new ModelRegistry({
  version: 1,
  models: {
    codex: {
      provider: 'openai',
      tier: 'boss',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
      codex: true,
    },
  },
  tiers: { boss: ['codex'] },
  failover: { triggers: [], maxRetries: 0, cooldownMs: 0, escalateAfterTierExhausted: false },
  routingRules: {},
});

async function commandFor(task: TaskType, overrides: Parameters<typeof makeContractRequest>[0] = {}) {
  const commands: string[] = [];
  const lines: string[] = [];
  const harness = new CodexCliHarness(
    async (cmd) => {
      commands.push(cmd);
      return { stdout: '', stderr: '' };
    },
    {},
    { env: {}, log: (line) => lines.push(line) },
  );
  const request = makeContractRequest({
    model: 'codex',
    registry,
    task,
    worktree,
    primaryRepoRoot: repo,
    writableRoots: [state, join(repo, '.git')],
    ...overrides,
  });
  await harness.run(request).catch(() => {});
  return { cmd: commands[0], lines, harness, request };
}

function configArg(command: string, key: string): string | undefined {
  const argv = execFileSync(
    '/bin/sh',
    ['-c', `set -- ${command.slice(0, command.indexOf(' -o '))}; printf '%s\\0' "$@"`],
    {
      encoding: 'utf8',
    },
  ).split('\0');
  const index = argv.findIndex((arg) => arg.startsWith(`${key}=`));
  return index < 0 ? undefined : argv[index].slice(key.length + 1);
}

describe('Codex workspace-write policy', () => {
  it('lets PLAN write its spec in state without granting the primary checkout', async () => {
    const { cmd } = await commandFor('plan', { writableRoots: [state, state, worktree, join(repo, '.git')] });
    expect(cmd).toContain('--sandbox workspace-write');
    const roots = JSON.parse(configArg(cmd, 'sandbox_workspace_write.writable_roots') ?? '[]') as string[];
    expect(roots).toEqual([state, join(repo, '.git')]);
    const spec = join(state, 'plans/issue-3249.md');
    expect(roots.some((root) => !relative(root, spec).startsWith('..'))).toBe(true);
    expect(roots).not.toContain(repo);
    expect(roots.some((root) => !relative(root, join(repo, 'sibling.txt')).startsWith('..'))).toBe(false);
  });

  it('drops a root containing the primary checkout and logs once', async () => {
    const { cmd, lines, harness, request } = await commandFor('plan', { writableRoots: ['/tmp', repo, state] });
    expect(JSON.parse(configArg(cmd, 'sandbox_workspace_write.writable_roots') ?? '[]')).toEqual([state]);
    await harness.run(request).catch(() => {});
    expect(lines.filter((line) => line.includes('dropped unsafe writable root'))).toHaveLength(1);
    expect(lines.filter((line) => line.includes('workspace-write for task plan'))).toHaveLength(1);
  });

  it('fails closed when extra roots have no primary checkout to guard against', async () => {
    const { cmd, lines } = await commandFor('plan', { primaryRepoRoot: undefined });
    expect(cmd).not.toContain('sandbox_workspace_write.writable_roots');
    expect(lines.some((line) => line.includes('dropped unsafe writable root'))).toBe(true);
  });

  it('allows GitHub API through the proxy for gh tasks, including without a sandbox policy', async () => {
    const policy: SandboxPolicy = {
      runtime: 'none',
      worktree,
      writablePaths: [worktree],
      writableFilePrefixes: [],
      allowHosts: ['registry.npmjs.org', 'github.com'],
      cpuMs: 1,
      memMb: 1,
    };
    for (const sandbox of [policy, undefined, { ...policy, allowHosts: [] }]) {
      const { cmd } = await commandFor('plan', { sandbox });
      expect(cmd).toContain('sandbox_workspace_write.network_access=true');
      const domains = configArg(cmd, 'features.network_proxy.domains') ?? '';
      for (const host of CODEX_GITHUB_HOSTS) expect(domains).toContain(`"${host}"="allow"`);
      if (sandbox === policy) expect(domains).toContain('"registry.npmjs.org"="allow"');
    }
  });

  it('denies network for tasks with no gh or push prompt', async () => {
    const { cmd } = await commandFor('check_custom');
    expect(cmd).toContain('sandbox_workspace_write.network_access=false');
    expect(cmd).not.toContain('features.network_proxy');
  });

  it('gives the publishing build GitHub egress and a commit-only build only the configured allowlist', async () => {
    const policy: SandboxPolicy = {
      runtime: 'none',
      worktree,
      writablePaths: [worktree],
      writableFilePrefixes: [],
      allowHosts: ['registry.npmjs.org'],
      cpuMs: 1,
      memMb: 1,
    };
    const publishing = await commandFor('build_claude', { sandbox: policy });
    const commitOnly = await commandFor('build_codex', { sandbox: policy });
    expect(publishing.cmd).toContain('sandbox_workspace_write.network_access=true');
    expect(publishing.cmd).toContain('"api.github.com"="allow"');
    expect(commitOnly.cmd).toContain('"registry.npmjs.org"="allow"');
    expect(commitOnly.cmd).not.toContain('"api.github.com"="allow"');
  });

  it('denies network for a commit-only build with no sandbox allowlist', async () => {
    const { cmd } = await commandFor('build_codex');
    expect(cmd).toContain('sandbox_workspace_write.network_access=false');
    expect(cmd).not.toContain('network_proxy');
  });

  it('denies network for a non-GitHub task even under an OS sandbox wrapper', async () => {
    const policy: SandboxPolicy = {
      runtime: 'sandbox-exec',
      worktree,
      writablePaths: [worktree],
      writableFilePrefixes: [],
      allowHosts: ['github.com'],
      cpuMs: 1,
      memMb: 1,
    };
    const { cmd } = await commandFor('check_design', { sandbox: policy });
    expect(cmd).toContain('sandbox_workspace_write.network_access=false');
    expect(cmd).not.toContain('features.network_proxy.domains');
  });

  it('never grants danger-full-access to any named task without config opt-in', async () => {
    const tasks: TaskType[] = [
      'plan',
      'build_codex',
      'build_claude',
      'build_opencode',
      'build_command',
      'check_compile',
      'check_tests',
      'check_lint',
      'check_accessibility',
      'check_links',
      'check_custom',
      'check_design',
      'review_pr',
      'security_review',
      'classify_pr',
      'dispute_resolution',
      'triage',
      'eval_judge',
      'readiness_enrich',
      'decompose',
    ];
    for (const task of tasks) {
      const { cmd } = await commandFor(task);
      expect(cmd).not.toContain('danger-full-access');
      expect(cmd).toContain('--sandbox workspace-write');
      expect(cmd).toContain(`sandbox_workspace_write.network_access=${CODEX_GITHUB_NETWORK_TASKS.has(task)}`);
    }
  });
});
