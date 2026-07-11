import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { ConstitutionLoader } from '../constitutions/index.js';
import { ModelRouter } from '../router/index.js';
import { StubModelExecutor } from '../router/stub.js';
import { checkPhase } from './check.js';

const models: ModelsConfig = {
  version: 1,
  models: {
    'stub-model': {
      provider: 'custom',
      tier: 'boss',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
    },
  },
  tiers: { boss: ['stub-model'] },
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
    build_claude: { tier: 'boss', description: 'stub' },
  },
};

const tempDirs = new Set<string>();

afterEach(async () => {
  await Promise.all([...tempDirs].map(dir => rm(dir, { recursive: true, force: true })));
  tempDirs.clear();
});

describe('checkPhase auto rework', () => {
  it('does not re-invoke the worker when auto rework is disabled', { timeout: 120_000 }, async () => {
    const { worktree, specPath } = await makeFailingWorktree();
    const { router, stub } = makeRouter();
    const constitutionLoader = new ConstitutionLoader();
    const log = () => {};

    const check = await checkPhase({
      issue: 77,
      worktree,
      specPath,
      router,
      constitutionLoader,
      log,
      autoRework: false,
    });

    expect(check.passed).toBe(false);
    expect(check.reworkRounds).toBe(0);
    expect(stub.calls).toHaveLength(0);
  });

  it('keeps the existing rework behavior by default', { timeout: 120_000 }, async () => {
    const { worktree, specPath } = await makeFailingWorktree();
    const { router, stub } = makeRouter();
    const constitutionLoader = new ConstitutionLoader();
    const log = () => {};

    const check = await checkPhase({
      issue: 77,
      worktree,
      specPath,
      router,
      constitutionLoader,
      log,
    });

    expect(check.passed).toBe(false);
    expect(check.reworkRounds).toBe(3);
    expect(stub.calls).toHaveLength(3);
  });
});

async function makeFailingWorktree(): Promise<{ worktree: string; specPath: string }> {
  const worktree = await mkdtemp(join(tmpdir(), 'check-phase-test-'));
  tempDirs.add(worktree);

  await writeFixture(worktree, 'package.json', JSON.stringify({
    scripts: { test: 'exit 1' },
  }));

  const specPath = join(worktree, 'issue-77.md');
  await writeFixture(worktree, 'issue-77.md', '# Spec: failing checks\n');

  return { worktree, specPath };
}

async function writeFixture(root: string, path: string, contents: string): Promise<void> {
  const fullPath = join(root, path);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, contents);
}

function makeRouter(): { router: ModelRouter; stub: StubModelExecutor } {
  const stub = new StubModelExecutor({ defaultOutput: 'rework complete' });
  return { router: new ModelRouter(models, routes, false, stub), stub };
}
