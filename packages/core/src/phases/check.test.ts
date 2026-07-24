import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { ModelRouter } from '../router/index.js';
import { StubModelExecutor } from '../router/stub.js';
import type { SandboxPolicy } from '../sandbox/index.js';
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

const twoModels: ModelsConfig = {
  ...models,
  models: {
    ...models.models,
    'second-model': {
      provider: 'custom',
      tier: 'boss',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
    },
  },
  tiers: { boss: ['stub-model', 'second-model'] },
};

const tempDirs = new Set<string>();

afterEach(async () => {
  await Promise.all([...tempDirs].map((dir) => rm(dir, { recursive: true, force: true })));
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
    expect(check.reworkRounds).toBe(2);
    expect(stub.calls).toHaveLength(2);
    expect(check.stuck).toBe(true);
  });

  it(
    'emits a stuck event once identical failures repeat across consecutive rework rounds',
    { timeout: 120_000 },
    async () => {
      const { worktree, specPath } = await makeFailingWorktree();
      const { router } = makeRouter();
      const logCalls: Array<
        [
          string,
          string,
          ({ rework?: { round: number; failingChecks: string[]; cause: string; stuck?: boolean } } | undefined)?,
        ]
      > = [];

      await checkPhase({
        issue: 77,
        worktree,
        specPath,
        router,
        constitution: null,
        log: (type, msg, extra) => {
          logCalls.push([type, msg, extra]);
        },
      });

      const stuckCalls = logCalls.filter(([type]) => type === 'stuck');
      expect(stuckCalls).toHaveLength(1);
      const rework = stuckCalls[0][2]?.rework;
      expect(rework?.stuck).toBe(true);
      expect(rework?.cause).toBe('factory-fault');
      expect(rework?.failingChecks.length).toBeGreaterThan(0);
    },
  );

  it('emits a rework event carrying structured cause metadata', { timeout: 120_000 }, async () => {
    const { worktree, specPath } = await makeFailingWorktree();
    const { router } = makeRouter();
    const logCalls: Array<
      [string, string, ({ rework?: { round: number; failingChecks: string[]; cause: string } } | undefined)?]
    > = [];

    await checkPhase({
      issue: 77,
      worktree,
      specPath,
      router,
      constitution: null,
      log: (type, msg, extra) => {
        logCalls.push([type, msg, extra]);
      },
    });

    const reworkCalls = logCalls.filter(([type]) => type === 'rework');
    expect(reworkCalls.length).toBeGreaterThan(0);
    const first = reworkCalls[0];
    expect(first[2]?.rework?.round).toBe(1);
    expect(first[2]?.rework?.cause).toBe('factory-fault');
    expect(first[2]?.rework?.failingChecks.length).toBeGreaterThan(0);
  });

  it('classifies the rework cause as direction-change when steering was applied', { timeout: 120_000 }, async () => {
    const { worktree, specPath } = await makeFailingWorktree();
    const { router } = makeRouter();
    const logCalls: Array<
      [string, string, ({ rework?: { round: number; failingChecks: string[]; cause: string } } | undefined)?]
    > = [];
    const drainSteering = () => ({
      messages: [{ id: 'steer-1', issue: 77, text: 'change the spec', queuedAt: '2026-01-01T00:00:00.000Z' }],
      attachments: [],
    });

    await checkPhase({
      issue: 77,
      worktree,
      specPath,
      router,
      constitution: null,
      log: (type, msg, extra) => {
        logCalls.push([type, msg, extra]);
      },
      drainSteering,
    });

    const reworkCalls = logCalls.filter(([type]) => type === 'rework');
    expect(reworkCalls[0][2]?.rework?.cause).toBe('direction-change');
  });

  it(
    'emits a structured failover event from the rework site when the rework worker fails over',
    { timeout: 120_000 },
    async () => {
      const { worktree, specPath } = await makeFailingWorktree();
      const stub = new StubModelExecutor({
        scripts: { build_claude: [{ fail: 'usage_cap' }, { output: 'rework complete' }] },
        defaultOutput: 'rework complete',
      });
      const router = new ModelRouter(twoModels, routes, false, stub);
      const logCalls: Array<[string, string, ({ failoverReason?: string } | undefined)?]> = [];

      await checkPhase({
        issue: 78,
        worktree,
        specPath,
        router,
        constitution: null,
        log: (type, msg, extra) => {
          logCalls.push([type, msg, extra]);
        },
      });

      expect(logCalls).toContainEqual([
        'failover',
        expect.stringContaining('usage_cap'),
        { failoverReason: 'usage_cap' },
      ]);
    },
  );

  it(
    'omits the detail suffix from the rework failover log when the failed attempt carries no detail',
    { timeout: 120_000 },
    async () => {
      const { worktree, specPath } = await makeFailingWorktree();
      const fakeRouter = {
        run: async () => ({
          model: 'stub-model',
          output: 'reworked',
          exitCode: 0,
          attempts: [
            { model: 'first-model', reason: 'timeout' as const, ok: false },
            { model: 'stub-model', reason: null, ok: true },
          ],
        }),
      } as any;
      const logs: Array<{ type: string; msg: string }> = [];

      await checkPhase({
        issue: 99,
        worktree,
        specPath,
        router: fakeRouter,
        constitution: null,
        log: (type, msg) => {
          logs.push({ type, msg });
        },
      });

      expect(logs).toContainEqual({ type: 'failover', msg: 'first-model failed (timeout) — failed over' });
    },
  );
});

describe('checkPhase sandbox', () => {
  it('forwards the sandbox policy + onSandboxEvent from reworkWorker to router.run', { timeout: 120_000 }, async () => {
    const { worktree, specPath } = await makeFailingWorktree();
    const sandbox: SandboxPolicy = {
      runtime: 'firejail',
      worktree,
      writablePaths: [worktree],
      allowHosts: [],
      cpuMs: 300_000,
      memMb: 4096,
    };
    const captured: { options: any }[] = [];
    const fakeRouter = {
      run: async (_task: string, _prompt: string, options: any) => {
        captured.push({ options });
        return { model: 'fake-model', output: 'reworked', exitCode: 0, attempts: [] };
      },
    } as any;
    const logs: Array<{ type: string; msg: string }> = [];

    await checkPhase({
      issue: 96,
      worktree,
      specPath,
      router: fakeRouter,
      constitution: null,
      log: (type, msg) => {
        logs.push({ type, msg });
      },
      sandbox,
    });

    expect(captured.length).toBeGreaterThan(0);
    expect(captured[0].options.sandbox).toBe(sandbox);
    expect(typeof captured[0].options.onSandboxEvent).toBe('function');

    captured[0].options.onSandboxEvent('resource_limit', 'cpu time limit exceeded');
    expect(logs).toContainEqual({ type: 'resource_limit', msg: 'cpu time limit exceeded' });
  });
});

describe('checkPhase appPort', () => {
  it('includes leaseEnv in the rework router.run options when appPort is set', async () => {
    const { worktree, specPath } = await makeFailingWorktree();
    const captured: { options: any }[] = [];
    const fakeRouter = {
      run: async (_task: string, _prompt: string, options: any) => {
        captured.push({ options });
        return { model: 'fake-model', output: 'reworked', exitCode: 0, attempts: [] };
      },
    } as any;

    await checkPhase({
      issue: 99,
      worktree,
      specPath,
      router: fakeRouter,
      constitution: null,
      log: () => {},
      appPort: 3142,
    });

    expect(captured.length).toBeGreaterThan(0);
    expect(captured[0].options.env).toEqual({
      PORT: '3142',
      FACTORY_APP_PORT: '3142',
      FACTORY_BASE_URL: 'http://127.0.0.1:3142',
    });
  });

  it('carries no env in the rework router.run options when appPort is unset', async () => {
    const { worktree, specPath } = await makeFailingWorktree();
    const captured: { options: any }[] = [];
    const fakeRouter = {
      run: async (_task: string, _prompt: string, options: any) => {
        captured.push({ options });
        return { model: 'fake-model', output: 'reworked', exitCode: 0, attempts: [] };
      },
    } as any;

    await checkPhase({
      issue: 100,
      worktree,
      specPath,
      router: fakeRouter,
      constitution: null,
      log: () => {},
    });

    expect(captured.length).toBeGreaterThan(0);
    expect(captured[0].options.env).toBeUndefined();
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
      log: (type, msg) => {
        logs.push({ type, msg });
      },
    });

    expect(check.passed).toBe(true);
    expect(check.reworkRounds).toBe(0);
    expect(check.summary.failures).toBe(0);
    // Worker is never invoked when nothing fails.
    expect(stub.calls).toHaveLength(0);
    expect(logs).toContainEqual({ type: 'check', msg: 'All checkers passed' });
  });

  it('passes with a skipped tests checker when the worktree has no test command', { timeout: 120_000 }, async () => {
    const { worktree, specPath } = await makeSpecOnlyWorktree();
    const { router, stub } = makeRouter();
    const logs: Array<{ type: string; msg: string }> = [];

    const check = await checkPhase({
      issue: 94,
      worktree,
      specPath,
      router,
      constitution: null,
      log: (type, msg) => {
        logs.push({ type, msg });
      },
    });

    expect(check.passed).toBe(true);
    expect(stub.calls).toHaveLength(0);
    expect(logs.some((l) => l.type === 'check' && l.msg.startsWith('SKIPPED: tests'))).toBe(true);
    expect(logs).toContainEqual({ type: 'check', msg: 'All checkers passed (1 skipped)' });
  });

  it(
    'fails the tests checker when requireTests is true and the worktree has no test command',
    { timeout: 120_000 },
    async () => {
      const { worktree, specPath } = await makeSpecOnlyWorktree();
      const { router } = makeRouter();
      const constitution: Constitution = {
        product: 'strict-app',
        version: 1,
        checkers: [],
        requireTests: true,
        body: 'Strict standards body.',
        path: worktree,
        source: 'bundled',
      };

      const check = await checkPhase({
        issue: 95,
        worktree,
        specPath,
        router,
        constitution,
        log: () => {},
        autoRework: false,
      });

      expect(check.passed).toBe(false);
      const testsFailure = check.summary.results.find((r) => r.checker === 'tests');
      expect(testsFailure?.result).toBe('FAIL');
      expect(testsFailure?.details).toContain('no verification command was run');
    },
  );

  it('exits the rework loop early once a round repairs the failing check', { timeout: 120_000 }, async () => {
    const { worktree, specPath } = await makeFailingWorktree();
    // The scripted worker "fixes" the repo the first time it is invoked by
    // rewriting the failing test script to pass, so the next check round is clean.
    const stub = new StubModelExecutor({
      scripts: {
        build_claude: [
          {
            output: 'fixed the failing test',
            effect: async (ctx) => {
              await writeFile(join(ctx.worktree, 'package.json'), JSON.stringify({ scripts: { test: 'exit 0' } }));
            },
          },
        ],
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
      log: (type, msg) => {
        logs.push({ type, msg });
      },
    });

    expect(check.passed).toBe(true);
    expect(check.reworkRounds).toBe(1);
    // Only one rework round was needed, so the worker was invoked exactly once.
    expect(stub.calls).toHaveLength(1);
    expect(logs).toContainEqual({ type: 'check', msg: 'Rework round 1: 0 failures remaining' });
    expect(logs).toContainEqual({ type: 'check', msg: 'All checkers passed' });
  });
});

describe('checkPhase steering', () => {
  it('invokes drainSteering once per rework round', { timeout: 120_000 }, async () => {
    const { worktree, specPath } = await makeFailingWorktree();
    const { router } = makeRouter();
    let calls = 0;
    const drainSteering = () => {
      calls++;
      return { messages: [], attachments: [] };
    };

    await checkPhase({
      issue: 100,
      worktree,
      specPath,
      router,
      constitution: null,
      log: () => {},
      drainSteering,
    });

    expect(calls).toBe(2);
  });

  it('applies drained steering to the rework prompt and logs steering_applied', { timeout: 120_000 }, async () => {
    const { worktree, specPath } = await makeFailingWorktree();
    const captured: string[] = [];
    const fakeRouter = {
      run: async (_task: string, prompt: string, _options: any) => {
        captured.push(prompt);
        return { model: 'fake-model', output: 'reworked', exitCode: 0, attempts: [] };
      },
    } as any;
    const logs: Array<{ type: string; msg: string }> = [];
    const drainSteering = () => ({
      messages: [
        { id: 'steer-1', issue: 100, text: 'focus on the lock file bug', queuedAt: '2026-01-01T00:00:00.000Z' },
      ],
      attachments: [],
    });

    await checkPhase({
      issue: 100,
      worktree,
      specPath,
      router: fakeRouter,
      constitution: null,
      log: (type, msg) => logs.push({ type, msg }),
      drainSteering,
      autoRework: true,
    });

    expect(captured[0]).toContain('## Operator guidance (steering)');
    expect(captured[0]).toContain('focus on the lock file bug');
    expect(logs.some((l) => l.type === 'steering_applied' && l.msg.includes('steer-1'))).toBe(true);
  });

  it(
    'leaves the rework prompt unchanged and logs nothing extra when no drainSteering is passed',
    { timeout: 120_000 },
    async () => {
      const { worktree, specPath } = await makeFailingWorktree();
      const captured: string[] = [];
      const fakeRouter = {
        run: async (_task: string, prompt: string, _options: any) => {
          captured.push(prompt);
          return { model: 'fake-model', output: 'reworked', exitCode: 0, attempts: [] };
        },
      } as any;
      const logs: Array<{ type: string; msg: string }> = [];

      await checkPhase({
        issue: 101,
        worktree,
        specPath,
        router: fakeRouter,
        constitution: null,
        log: (type, msg) => logs.push({ type, msg }),
      });

      expect(captured[0]).not.toContain('## Operator guidance (steering)');
      expect(logs.some((l) => l.type === 'steering_applied')).toBe(false);
    },
  );

  it(
    'logs no steering_applied event and leaves the prompt unchanged when drainSteering returns empty',
    { timeout: 120_000 },
    async () => {
      const { worktree, specPath } = await makeFailingWorktree();
      const captured: string[] = [];
      const fakeRouter = {
        run: async (_task: string, prompt: string, _options: any) => {
          captured.push(prompt);
          return { model: 'fake-model', output: 'reworked', exitCode: 0, attempts: [] };
        },
      } as any;
      const logs: Array<{ type: string; msg: string }> = [];

      await checkPhase({
        issue: 102,
        worktree,
        specPath,
        router: fakeRouter,
        constitution: null,
        log: (type, msg) => logs.push({ type, msg }),
        drainSteering: () => ({ messages: [], attachments: [] }),
      });

      expect(captured[0]).not.toContain('## Operator guidance (steering)');
      expect(logs.some((l) => l.type === 'steering_applied')).toBe(false);
    },
  );
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

  it('emits a structured failover event when a log callback is provided and the dispute router fails over', async () => {
    const stub = new StubModelExecutor({
      scripts: {
        dispute_resolution: [{ fail: 'usage_cap' }, { output: '{"verdict":"upheld","reasoning":"r","action":"a"}' }],
      },
    });
    const router = new ModelRouter(twoModels, routes, false, stub);
    const logCalls: Array<[string, string, ({ failoverReason?: string } | undefined)?]> = [];

    const result = await disputeResolution({
      issue: 94,
      worktree: '/tmp/wt',
      specPath: '/tmp/wt/spec.md',
      checkerName: 'custom_style',
      checkerDetails: 'naming disagreement',
      constitution: null,
      router,
      log: (type, msg, extra) => {
        logCalls.push([type, msg, extra]);
      },
    });

    expect(result.verdict).toBe('upheld');
    expect(logCalls).toContainEqual([
      'failover',
      expect.stringContaining('usage_cap'),
      { failoverReason: 'usage_cap' },
    ]);
  });

  it('omits the detail suffix from the dispute failover log when the failed attempt carries no detail', async () => {
    const fakeRouter = {
      run: async () => ({
        model: 'stub-model',
        output: '{"verdict":"upheld","reasoning":"r","action":"a"}',
        exitCode: 0,
        attempts: [
          { model: 'first-model', reason: 'timeout' as const, ok: false },
          { model: 'stub-model', reason: null, ok: true },
        ],
      }),
    } as any;
    const logCalls: Array<[string, string, ({ failoverReason?: string } | undefined)?]> = [];

    const result = await disputeResolution({
      issue: 97,
      worktree: '/tmp/wt',
      specPath: '/tmp/wt/spec.md',
      checkerName: 'custom_style',
      checkerDetails: 'naming disagreement',
      constitution: null,
      router: fakeRouter,
      log: (type, msg, extra) => {
        logCalls.push([type, msg, extra]);
      },
    });

    expect(result.verdict).toBe('upheld');
    expect(logCalls).toContainEqual([
      'failover',
      'first-model failed (timeout) — failed over',
      { failoverReason: 'timeout' },
    ]);
  });

  it('does not throw when no log callback is provided and the dispute router fails over', async () => {
    const stub = new StubModelExecutor({
      scripts: {
        dispute_resolution: [{ fail: 'usage_cap' }, { output: '{"verdict":"upheld","reasoning":"r","action":"a"}' }],
      },
    });
    const router = new ModelRouter(twoModels, routes, false, stub);

    await expect(
      disputeResolution({
        issue: 95,
        worktree: '/tmp/wt',
        specPath: '/tmp/wt/spec.md',
        checkerName: 'custom_style',
        checkerDetails: 'naming disagreement',
        constitution: null,
        router,
      }),
    ).resolves.toMatchObject({ verdict: 'upheld' });
  });
});

async function makePassingWorktree(): Promise<{ worktree: string; specPath: string }> {
  const worktree = await mkdtemp(join(tmpdir(), 'check-phase-pass-'));
  tempDirs.add(worktree);

  await writeFixture(
    worktree,
    'package.json',
    JSON.stringify({
      scripts: { test: 'exit 0' },
    }),
  );

  const specPath = join(worktree, 'issue-88.md');
  await writeFixture(worktree, 'issue-88.md', '# Spec: passing checks\n');

  return { worktree, specPath };
}

async function makeSpecOnlyWorktree(): Promise<{ worktree: string; specPath: string }> {
  const worktree = await mkdtemp(join(tmpdir(), 'check-phase-spec-only-'));
  tempDirs.add(worktree);

  const specPath = join(worktree, 'issue-94.md');
  await writeFixture(worktree, 'issue-94.md', '# Spec: no package.json at all\n');

  return { worktree, specPath };
}

async function makeFailingWorktree(): Promise<{ worktree: string; specPath: string }> {
  const worktree = await mkdtemp(join(tmpdir(), 'check-phase-test-'));
  tempDirs.add(worktree);

  await writeFixture(
    worktree,
    'package.json',
    JSON.stringify({
      scripts: { test: 'exit 1' },
    }),
  );

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
