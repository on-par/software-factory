import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { ModelRouter } from '../router/index.js';
import { StubModelExecutor } from '../router/stub.js';
import type { Constitution } from '../types/index.js';
import { checkPhase, disputeResolution } from './check.js';

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
    dispute_resolution: { tier: 'boss', description: 'stub' },
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
    const constitution = null;
    const log = () => {};

    const check = await checkPhase({
      issue: 77,
      worktree,
      specPath,
      router,
      constitution,
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
    const constitution = null;
    const log = () => {};

    const check = await checkPhase({
      issue: 77,
      worktree,
      specPath,
      router,
      constitution,
      log,
    });

    expect(check.passed).toBe(false);
    expect(check.reworkRounds).toBe(3);
    expect(stub.calls).toHaveLength(3);
  });
});

describe('checkPhase success paths', () => {
  it('passes without rework when all checkers pass on a clean worktree', { timeout: 120_000 }, async () => {
    const { worktree, specPath } = await makePassingWorktree();
    const { router, stub } = makeRouter();
    const logs: Array<{ type: string; msg: string }> = [];

    const check = await checkPhase({
      issue: 88,
      worktree,
      specPath,
      router,
      constitution: null,
      log: (type, msg) => { logs.push({ type, msg }); },
    });

    expect(check.passed).toBe(true);
    expect(check.reworkRounds).toBe(0);
    expect(check.summary.failures).toBe(0);
    // Worker is never invoked when nothing fails.
    expect(stub.calls).toHaveLength(0);
    expect(logs).toContainEqual({ type: 'check', msg: 'All checkers passed' });
  });

  it('exits the rework loop early once a round repairs the failing check', { timeout: 120_000 }, async () => {
    const { worktree, specPath } = await makeFailingWorktree();
    // The scripted worker "fixes" the repo the first time it is invoked by
    // rewriting the failing test script to pass, so the next check round is clean.
    const stub = new StubModelExecutor({
      scripts: {
        build_claude: [{
          output: 'fixed the failing test',
          effect: async (ctx) => {
            await writeFile(
              join(ctx.worktree, 'package.json'),
              JSON.stringify({ scripts: { test: 'exit 0' } }),
            );
          },
        }],
      },
    });
    const router = new ModelRouter(models, routes, false, stub);
    const logs: Array<{ type: string; msg: string }> = [];

    const check = await checkPhase({
      issue: 89,
      worktree,
      specPath,
      router,
      constitution: null,
      log: (type, msg) => { logs.push({ type, msg }); },
    });

    expect(check.passed).toBe(true);
    expect(check.reworkRounds).toBe(1);
    // Only one rework round was needed, so the worker was invoked exactly once.
    expect(stub.calls).toHaveLength(1);
    expect(logs).toContainEqual({ type: 'check', msg: 'Rework round 1: 0 failures remaining' });
    expect(logs).toContainEqual({ type: 'check', msg: 'All checkers passed' });
  });
});

describe('disputeResolution', () => {
  const constitution: Constitution = {
    product: 'demo',
    version: 1,
    checkers: [],
    body: '## Standards\nAll code must be reviewed.',
    path: '/tmp/wt/constitution.md',
    source: 'repo',
  };

  function disputeRouter(output: string | { fail: 'timeout' }): { router: ModelRouter } {
    const step = typeof output === 'string' ? { output } : output;
    const stub = new StubModelExecutor({ scripts: { dispute_resolution: [step] } });
    return { router: new ModelRouter(models, routes, false, stub) };
  }

  it('parses an overruled verdict with reasoning and action from the agent JSON', async () => {
    const { router } = disputeRouter(
      '{"verdict":"overruled","reasoning":"the standard permits this pattern","action":"merge as-is"}',
    );

    const result = await disputeResolution({
      issue: 90,
      worktree: '/tmp/wt',
      specPath: '/tmp/wt/spec.md',
      checkerName: 'custom_style',
      checkerDetails: 'naming disagreement',
      constitution,
      router,
    });

    expect(result).toEqual({
      verdict: 'overruled',
      reasoning: 'the standard permits this pattern',
      action: 'merge as-is',
    });
  });

  it('upholds and yields empty reasoning/action when the output has no JSON verdict', async () => {
    const { router } = disputeRouter('the agent rambled without emitting any verdict json');

    const result = await disputeResolution({
      issue: 91,
      worktree: '/tmp/wt',
      specPath: '/tmp/wt/spec.md',
      checkerName: 'custom_style',
      checkerDetails: 'naming disagreement',
      constitution: null,
      router,
    });

    expect(result).toEqual({ verdict: 'upheld', reasoning: '', action: '' });
  });

  it('extracts an upheld verdict and reasoning while defaulting a missing action', async () => {
    const { router } = disputeRouter('{"verdict":"upheld","reasoning":"the standard is explicit"}');

    const result = await disputeResolution({
      issue: 92,
      worktree: '/tmp/wt',
      specPath: '/tmp/wt/spec.md',
      checkerName: 'custom_style',
      checkerDetails: 'naming disagreement',
      constitution,
      router,
    });

    expect(result.verdict).toBe('upheld');
    expect(result.reasoning).toBe('the standard is explicit');
    expect(result.action).toBe('');
  });

  it('falls back to upheld when the dispute agent fails entirely', async () => {
    const { router } = disputeRouter({ fail: 'timeout' });

    const result = await disputeResolution({
      issue: 93,
      worktree: '/tmp/wt',
      specPath: '/tmp/wt/spec.md',
      checkerName: 'custom_style',
      checkerDetails: 'naming disagreement',
      constitution: null,
      router,
      timeoutSeconds: 5,
    });

    expect(result).toEqual({
      verdict: 'upheld',
      reasoning: 'dispute agent failed',
      action: 'worker must fix',
    });
  });
});

async function makePassingWorktree(): Promise<{ worktree: string; specPath: string }> {
  const worktree = await mkdtemp(join(tmpdir(), 'check-phase-pass-'));
  tempDirs.add(worktree);

  await writeFixture(worktree, 'package.json', JSON.stringify({
    scripts: { test: 'exit 0' },
  }));

  const specPath = join(worktree, 'issue-88.md');
  await writeFixture(worktree, 'issue-88.md', '# Spec: passing checks\n');

  return { worktree, specPath };
}

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
