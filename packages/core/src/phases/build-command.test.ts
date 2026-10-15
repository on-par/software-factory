import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { CliModelExecutor, ModelRouter } from '../router/index.js';
import { StubModelExecutor } from '../router/stub.js';
import { buildPhase } from './build.js';

const models: ModelsConfig = {
  version: 1,
  models: {
    'my-model': {
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
  tiers: { worker: ['my-model'] },
  failover: {
    triggers: ['rate_limit', 'usage_cap', 'timeout', 'error', 'empty_response'],
    maxRetries: 2,
    cooldownMs: 0,
    escalateAfterTierExhausted: true,
  },
  routingRules: {},
  harnesses: {
    'my-agent': { command: 'my-agent {model}', prompt: 'stdin', output: 'stdout', agentic: true, usage: 'none' },
  },
};

const routes: RoutesConfig = {
  version: 1,
  routes: {
    build_claude: { tier: 'worker', description: 'stub', requires: 'claude' },
    build_codex: { tier: 'worker', description: 'stub', requires: 'codex' },
    build_command: { tier: 'worker', description: 'stub', requires: 'command' },
  },
};

const tempDirs = new Set<string>();

afterEach(async () => {
  await Promise.all([...tempDirs].map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.clear();
});

async function run(stub: StubModelExecutor, issue: number, logs: string[] = []) {
  const worktree = await mkdtemp(join(tmpdir(), 'build-phase-test-'));
  tempDirs.add(worktree);
  return buildPhase({
    issue,
    repo: 'on-par/software-factory',
    worktree,
    specPath: join(worktree, `issue-${issue}.md`),
    branch: `ship-it/${issue}-command`,
    route: 'command',
    router: new ModelRouter(models, routes, false, stub),
    constitution: null,
    log: (type) => {
      logs.push(type);
    },
    modelOverride: 'my-model',
  });
}

describe('buildPhase command route (#2872)', () => {
  it('route command runs build_command with the commit-only prompt and the pinned model', async () => {
    const stub = new StubModelExecutor({ scripts: { build_command: [{ output: 'command output' }] } });
    const logs: string[] = [];

    const result = await run(stub, 2872, logs);

    expect(result.ok).toBe(true);
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0].task).toBe('build_command');
    expect(stub.calls[0].model).toBe('my-model');
    expect(stub.calls[0].prompt).toMatch(/^Implement issue #/);
    expect(logs).not.toContain('model_override_ignored');
  });

  it('a Pi build pin runs PiHarness on the command route and leaves a local commit (#2909)', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'build-phase-pi-'));
    tempDirs.add(worktree);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: worktree, encoding: 'utf8' }).trim();
    git('init', '-q');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.com');
    git('config', 'commit.gpgsign', 'false');
    await writeFile(join(worktree, 'README.md'), 'hi\n');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    expect(git('rev-list', '--count', 'HEAD')).toBe('1');

    const piStdout =
      '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"stopReason":"stop"}}\n{"type":"agent_settled","aborted":false}\n';
    const stubExec = async (cmd: string, opts: { cwd?: string }) => {
      expect(cmd.startsWith('pi -p --mode json')).toBe(true);
      const cwd = opts.cwd ?? worktree;
      await writeFile(join(cwd, 'feature.txt'), 'feature\n');
      execFileSync('git', ['add', '.'], { cwd });
      execFileSync('git', ['commit', '-q', '-m', 'feat: add feature'], { cwd });
      return { stdout: piStdout, stderr: '' };
    };
    const piModels: ModelsConfig = {
      ...models,
      models: {
        'pi-model': {
          provider: 'custom',
          tier: 'worker',
          costPerMtokInput: 0,
          costPerMtokOutput: 0,
          contextWindow: 1000,
          capabilities: [],
          envKey: null,
          harness: 'pi',
          providerModel: 'openrouter/deepseek/deepseek-v4-flash',
        },
      },
      tiers: { worker: ['pi-model'] },
      harnesses: undefined,
    };

    const result = await buildPhase({
      issue: 2909,
      repo: 'on-par/software-factory',
      worktree,
      specPath: join(worktree, 'issue-2909.md'),
      branch: 'ship-it/2909-pi',
      route: 'command',
      router: new ModelRouter(piModels, routes, false, new CliModelExecutor(stubExec)),
      constitution: null,
      log: () => {},
      modelOverride: 'pi-model',
    });

    expect(result.ok).toBe(true);
    expect(result.route).toBe('command');
    expect(result.model).toBe('pi-model');
    expect(git('rev-list', '--count', 'HEAD')).toBe('2');
  });

  it('rethrows a usage_cap failure with no claude/codex cross-harness failover', async () => {
    const stub = new StubModelExecutor({ scripts: { build_command: [{ fail: 'usage_cap' }] } });

    await expect(run(stub, 2873)).rejects.toThrow();
    expect(stub.calls.every((c) => c.task === 'build_command')).toBe(true);
  });
});
