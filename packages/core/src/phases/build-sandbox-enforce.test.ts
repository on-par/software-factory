import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it } from 'vitest';

import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { ModelRouter } from '../router/index.js';
import { StubModelExecutor } from '../router/stub.js';
import type { SandboxPolicy } from '../sandbox/index.js';

import { buildPhase } from './build.js';

const models: ModelsConfig = {
  version: 1,
  models: {
    'stub-worker': {
      provider: 'custom',
      tier: 'worker',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
    },
  },
  tiers: { worker: ['stub-worker'] },
  failover: { triggers: ['error'], maxRetries: 2, cooldownMs: 0, escalateAfterTierExhausted: true },
  routingRules: {},
};

const routes: RoutesConfig = { version: 1, routes: { build_claude: { tier: 'worker', description: 'stub' } } };

const tempDirs = new Set<string>();

afterEach(async () => {
  await Promise.all([...tempDirs].map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.clear();
});

it('logs an allowlist-enforced sandbox start event in enforce mode (#2215)', async () => {
  const worktree = await mkdtemp(join(tmpdir(), 'build-phase-test-'));
  tempDirs.add(worktree);
  const specPath = join(worktree, 'issue-94.md');
  const sandbox: SandboxPolicy = {
    runtime: 'sandbox-exec',
    worktree,
    writablePaths: [worktree],
    writableFilePrefixes: [],
    allowHosts: ['example.com'],
    networkMode: 'enforce',
    cpuMs: 300_000,
    memMb: 4096,
  };
  const stub = new StubModelExecutor({ scripts: { build_claude: [{ output: 'claude output' }] } });
  const router = new ModelRouter(models, routes, false, stub);
  const logs: Array<{ type: string; msg: string }> = [];

  const result = await buildPhase({
    issue: 94,
    repo: 'on-par/software-factory',
    worktree,
    specPath,
    branch: 'ship-it/94-sandbox-enforce',
    route: 'claude',
    router,
    constitution: null,
    log: (type, msg) => {
      logs.push({ type, msg });
    },
    sandbox,
  });

  expect(result.ok).toBe(true);
  expect(logs).toContainEqual({
    type: 'sandbox',
    msg: 'containment active (runtime sandbox-exec, net allowlist enforced)',
  });
  expect(logs.some((l) => l.msg.includes('allow-list'))).toBe(false);
});
