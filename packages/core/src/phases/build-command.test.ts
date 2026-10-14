import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { ModelRouter } from '../router/index.js';
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

  it('rethrows a usage_cap failure with no claude/codex cross-harness failover', async () => {
    const stub = new StubModelExecutor({ scripts: { build_command: [{ fail: 'usage_cap' }] } });

    await expect(run(stub, 2873)).rejects.toThrow();
    expect(stub.calls.every((c) => c.task === 'build_command')).toBe(true);
  });
});
