import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { ConstitutionLoader } from '../constitutions/index.js';
import { ModelRouter } from '../router/index.js';
import { StubModelExecutor } from '../router/stub.js';
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
    'stub-codex': {
      provider: 'openai',
      tier: 'worker',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: ['codex'],
      envKey: null,
      codex: true,
    },
  },
  tiers: { worker: ['stub-codex', 'stub-worker'] },
  failover: {
    triggers: ['rate_limit', 'usage_cap', 'timeout', 'error', 'empty_response'],
    maxRetries: 2,
    cooldownMs: 0,
    escalateAfterTierExhausted: true,
  },
  routingRules: {},
};

const routes: RoutesConfig = {
  version: 1,
  routes: {
    build_claude: { tier: 'worker', description: 'stub' },
    build_codex: { tier: 'worker', description: 'stub', requires: 'codex' },
  },
};

const tempDirs = new Set<string>();

afterEach(async () => {
  await Promise.all([...tempDirs].map(dir => rm(dir, { recursive: true, force: true })));
  tempDirs.clear();
});

describe('buildPhase FACTORY_CODEX kill-switch', () => {
  const prevFactoryCodex = process.env.FACTORY_CODEX;

  beforeEach(() => {
    delete process.env.FACTORY_CODEX;
  });

  afterEach(() => {
    if (prevFactoryCodex === undefined) delete process.env.FACTORY_CODEX;
    else process.env.FACTORY_CODEX = prevFactoryCodex;
  });

  it('falls back to build_claude and logs a warn when FACTORY_CODEX=0', async () => {
    process.env.FACTORY_CODEX = '0';

    const worktree = await mkdtemp(join(tmpdir(), 'build-phase-test-'));
    tempDirs.add(worktree);
    const specPath = join(worktree, 'issue-79.md');
    const stub = new StubModelExecutor({
      scripts: {
        build_codex: [{ output: 'codex output' }],
        build_claude: [{ output: 'claude output' }],
      },
    });
    const router = new ModelRouter(models, routes, false, stub);
    const logs: Array<{ type: string; msg: string }> = [];

    const result = await buildPhase({
      issue: 79,
      repo: 'on-par/software-factory',
      worktree,
      specPath,
      branch: 'ship-it/79-add-factory-codex-0-kill-switch',
      route: 'codex',
      router,
      constitutionLoader: new ConstitutionLoader(),
      log: (type, msg) => { logs.push({ type, msg }); },
    });

    expect(result.ok).toBe(true);
    expect(stub.calls[stub.calls.length - 1].task).toBe('build_claude');
    expect(logs).toContainEqual({ type: 'warn', msg: 'codex unavailable — falling back to claude' });
  });

  it('uses build_codex and logs no warn when FACTORY_CODEX is unset', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'build-phase-test-'));
    tempDirs.add(worktree);
    const specPath = join(worktree, 'issue-79.md');
    const stub = new StubModelExecutor({
      scripts: {
        build_codex: [{ output: 'codex output' }],
        build_claude: [{ output: 'claude output' }],
      },
    });
    const router = new ModelRouter(models, routes, false, stub);
    const logs: Array<{ type: string; msg: string }> = [];

    const result = await buildPhase({
      issue: 79,
      repo: 'on-par/software-factory',
      worktree,
      specPath,
      branch: 'ship-it/79-add-factory-codex-0-kill-switch',
      route: 'codex',
      router,
      constitutionLoader: new ConstitutionLoader(),
      log: (type, msg) => { logs.push({ type, msg }); },
    });

    expect(result.ok).toBe(true);
    expect(stub.calls[stub.calls.length - 1].task).toBe('build_codex');
    expect(logs.some(l => l.type === 'warn')).toBe(false);
  });
});
