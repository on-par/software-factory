import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { ModelRouter } from '../router/index.js';
import { StubModelExecutor } from '../router/stub.js';
import type { SandboxPolicy } from '../sandbox/index.js';
import type { Constitution, ReworkInfo } from '../types/index.js';
import { checkPhase } from './check.js';

const models: ModelsConfig = {
  version: 1,
  models: {
    'stub-model': {
      provider: 'openai',
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

  it('stops after the configured single targeted repair pass', { timeout: 120_000 }, async () => {
    const { worktree, specPath } = await makeFailingWorktree();
    const { router, stub } = makeRouter();

    const check = await checkPhase({
      issue: 77,
      worktree,
      specPath,
      router,
      constitution: null,
      log: () => {},
      maxReworkRounds: 1,
    });

    expect(check.passed).toBe(false);
    expect(check.reworkRounds).toBe(1);
    expect(stub.calls).toHaveLength(1);
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
      const logCalls: Array<[string, string, ({ rework?: ReworkInfo } | undefined)?]> = [];

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
    const logCalls: Array<[string, string, ({ rework?: ReworkInfo } | undefined)?]> = [];

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

  it('captures bounded test identifiers and output in rework and stuck events', { timeout: 120_000 }, async () => {
    const { worktree, specPath } = await makeTestFailureEvidenceWorktree();
    const { router } = makeRouter();
    const logCalls: Array<[string, string, { rework?: ReworkInfo } | undefined]> = [];

    await checkPhase({
      issue: 491,
      worktree,
      specPath,
      router,
      constitution: null,
      log: (type, msg, extra) => {
        logCalls.push([type, msg, extra]);
      },
    });

    const rework = logCalls.find(([type]) => type === 'rework')?.[2]?.rework;
    expect(rework).toMatchObject({
      cause: 'factory-fault',
      failingTests: [
        'src/phases/build.test.ts > buildPhase > uses the Codex route',
        'reports the fallback warning',
        'restores the inherited environment',
      ],
    });
    expect(rework?.failureOutput).toContain('FAIL  src/phases/build.test.ts > buildPhase > uses the Codex route');
    expect(rework?.failureOutput?.length).toBeLessThanOrEqual(400);

    const stuck = logCalls.find(([type]) => type === 'stuck')?.[2]?.rework;
    expect(stuck?.failingTests).toEqual(rework?.failingTests);
    expect(stuck?.failureOutput).toBe(rework?.failureOutput);
  });

  it('does not invent test evidence for non-test checker failures', { timeout: 120_000 }, async () => {
    const { worktree, specPath } = await makeLintFailingWorktree();
    const { router } = makeRouter();
    const logCalls: Array<[string, string, { rework?: ReworkInfo } | undefined]> = [];

    await checkPhase({
      issue: 492,
      worktree,
      specPath,
      router,
      constitution: null,
      log: (type, msg, extra) => {
        logCalls.push([type, msg, extra]);
      },
    });

    const rework = logCalls.find(([type]) => type === 'rework')?.[2]?.rework;
    expect(rework).toMatchObject({ cause: 'factory-fault', failingChecks: ['lint'] });
    expect(rework?.failingTests).toBeUndefined();
    expect(rework?.failureOutput).toBeUndefined();
  });

  it('classifies the rework cause as direction-change when steering was applied', { timeout: 120_000 }, async () => {
    const { worktree, specPath } = await makeFailingWorktree();
    const { router } = makeRouter();
    const logCalls: Array<[string, string, ({ rework?: ReworkInfo } | undefined)?]> = [];
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
    'classifies usage_cap router exhaustion as external and never produces a false stuck',
    { timeout: 120_000 },
    async () => {
      const { worktree, specPath } = await makeFailingWorktree();
      const stub = new StubModelExecutor({
        scripts: { build_claude: [{ fail: 'usage_cap' }, { fail: 'usage_cap' }, { fail: 'usage_cap' }] },
        defaultOutput: 'rework complete',
      });
      const router = new ModelRouter(models, routes, false, stub);
      const logCalls: Array<[string, string, ({ failoverReason?: string; rework?: ReworkInfo } | undefined)?]> = [];

      const check = await checkPhase({
        issue: 642,
        worktree,
        specPath,
        router,
        constitution: null,
        log: (type, msg, extra) => {
          logCalls.push([type, msg, extra]);
        },
      });

      const failedCalls = logCalls.filter(([type]) => type === 'rework_model_failed');
      expect(failedCalls.length).toBeGreaterThan(0);
      expect(failedCalls[0][1]).toContain('usage_cap');
      expect(failedCalls[0][2]).toEqual({ failoverReason: 'usage_cap' });

      const reworkCalls = logCalls.filter(([type]) => type === 'rework');
      expect(reworkCalls.length).toBeGreaterThan(0);
      for (const call of reworkCalls) {
        expect(call[2]?.rework?.cause).toBe('external');
      }

      expect(logCalls.some(([type]) => type === 'stuck')).toBe(false);
      expect(check.stuck).toBeFalsy();
      expect(check.reworkRounds).toBe(3);
    },
  );

  it('classifies a non-external router exhaustion reason as factory-fault', { timeout: 120_000 }, async () => {
    const { worktree, specPath } = await makeFailingWorktree();
    const stub = new StubModelExecutor({
      scripts: { build_claude: [{ fail: 'error' }, { fail: 'error' }] },
      defaultOutput: 'rework complete',
    });
    const router = new ModelRouter(models, routes, false, stub);
    const logCalls: Array<[string, string, ({ failoverReason?: string; rework?: ReworkInfo } | undefined)?]> = [];

    await checkPhase({
      issue: 642,
      worktree,
      specPath,
      router,
      constitution: null,
      log: (type, msg, extra) => {
        logCalls.push([type, msg, extra]);
      },
      maxReworkRounds: 1,
    });

    const failedCalls = logCalls.filter(([type]) => type === 'rework_model_failed');
    expect(failedCalls.length).toBeGreaterThan(0);
    expect(failedCalls[0][2]).toEqual({ failoverReason: 'error' });

    const reworkCalls = logCalls.filter(([type]) => type === 'rework');
    expect(reworkCalls.length).toBeGreaterThan(0);
    expect(reworkCalls[0][2]?.rework?.cause).toBe('factory-fault');
  });

  it(
    'still emits failover events for real model switches recorded on a failed rework run',
    { timeout: 120_000 },
    async () => {
      const { worktree, specPath } = await makeFailingWorktree();
      const stub = new StubModelExecutor({
        scripts: { build_claude: [{ fail: 'usage_cap' }, { fail: 'usage_cap' }] },
        defaultOutput: 'rework complete',
      });
      const router = new ModelRouter(twoModels, routes, false, stub);
      const logCalls: Array<[string, string, ({ failoverReason?: string } | undefined)?]> = [];

      await checkPhase({
        issue: 642,
        worktree,
        specPath,
        router,
        constitution: null,
        log: (type, msg, extra) => {
          logCalls.push([type, msg, extra]);
        },
        maxReworkRounds: 1,
      });

      expect(logCalls).toContainEqual([
        'failover',
        expect.stringContaining('usage_cap'),
        { failoverReason: 'usage_cap' },
      ]);
      expect(logCalls.some(([type]) => type === 'rework_model_failed')).toBe(true);
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
    expect(captured[0].options.retryCause).toBe('checker');

    captured[0].options.onSandboxEvent('resource_limit', 'cpu time limit exceeded');
    expect(logs).toContainEqual({ type: 'resource_limit', msg: 'cpu time limit exceeded' });
  });
});

describe('checkPhase appPort', () => {
  let prevFactoryHeadless: string | undefined;

  beforeEach(() => {
    prevFactoryHeadless = process.env.FACTORY_HEADLESS;
    delete process.env.FACTORY_HEADLESS;
  });

  afterEach(() => {
    if (prevFactoryHeadless === undefined) delete process.env.FACTORY_HEADLESS;
    else process.env.FACTORY_HEADLESS = prevFactoryHeadless;
  });

  it('includes laneEnv in the rework router.run options when appPort is set', async () => {
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
      FACTORY_HEADLESS: '1',
      PLAYWRIGHT_HEADLESS: '1',
      PORT: '3142',
      FACTORY_APP_PORT: '3142',
      FACTORY_BASE_URL: 'http://127.0.0.1:3142',
    });
  });

  it('reaches the rework router.run options as FACTORY_BASE_URL while FACTORY_APP_PORT stays the raw port, when appBaseUrl is set', async () => {
    const { worktree, specPath } = await makeFailingWorktree();
    const captured: { options: any }[] = [];
    const fakeRouter = {
      run: async (_task: string, _prompt: string, options: any) => {
        captured.push({ options });
        return { model: 'fake-model', output: 'reworked', exitCode: 0, attempts: [] };
      },
    } as any;

    await checkPhase({
      issue: 101,
      worktree,
      specPath,
      router: fakeRouter,
      constitution: null,
      log: () => {},
      appPort: 3142,
      appBaseUrl: 'http://ship-it-101.factory.localhost',
    });

    expect(captured.length).toBeGreaterThan(0);
    expect(captured[0].options.env).toEqual({
      FACTORY_HEADLESS: '1',
      PLAYWRIGHT_HEADLESS: '1',
      PORT: '3142',
      FACTORY_APP_PORT: '3142',
      FACTORY_BASE_URL: 'http://ship-it-101.factory.localhost',
    });
  });

  it('carries headless-only env in the rework router.run options when appPort is unset', async () => {
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
    expect(captured[0].options.env).toEqual({ FACTORY_HEADLESS: '1', PLAYWRIGHT_HEADLESS: '1' });
  });

  it('forwards onPgid to the rework router.run options', async () => {
    const { worktree, specPath } = await makeFailingWorktree();
    const captured: { options: any }[] = [];
    const fakeRouter = {
      run: async (_task: string, _prompt: string, options: any) => {
        captured.push({ options });
        return { model: 'fake-model', output: 'reworked', exitCode: 0, attempts: [] };
      },
    } as any;
    const onPgid = () => {};

    await checkPhase({
      issue: 103,
      worktree,
      specPath,
      router: fakeRouter,
      constitution: null,
      log: () => {},
      appPort: 3142,
      onPgid,
    });

    expect(captured.length).toBeGreaterThan(0);
    expect(captured[0].options.onPgid).toBe(onPgid);
  });

  it('forwards buildTimeoutSeconds to the rework router.run options as timeoutSeconds', async () => {
    const { worktree, specPath } = await makeFailingWorktree();
    const captured: { options: any }[] = [];
    const fakeRouter = {
      run: async (_task: string, _prompt: string, options: any) => {
        captured.push({ options });
        return { model: 'fake-model', output: 'reworked', exitCode: 0, attempts: [] };
      },
    } as any;

    await checkPhase({
      issue: 105,
      worktree,
      specPath,
      router: fakeRouter,
      constitution: null,
      log: () => {},
      buildTimeoutSeconds: 1234,
    });

    expect(captured.length).toBeGreaterThan(0);
    expect(captured[0].options.timeoutSeconds).toBe(1234);
  });

  it('threads the lane env into the checker ctx so checker commands see it', { timeout: 30_000 }, async () => {
    const worktree = await makeEnvAssertingWorktree(101);
    const { router, stub } = makeRouter();

    const check = await checkPhase({
      issue: 101,
      worktree,
      specPath: join(worktree, 'issue-101.md'),
      router,
      constitution: null,
      log: () => {},
      appPort: 3142,
      autoRework: false,
    });

    expect(check.passed).toBe(true);
    expect(stub.calls).toHaveLength(0);
  });

  it('fails the tests checker when appPort (and so ctx.env) is absent', { timeout: 30_000 }, async () => {
    const worktree = await makeEnvAssertingWorktree(102);
    const { router } = makeRouter();

    const check = await checkPhase({
      issue: 102,
      worktree,
      specPath: join(worktree, 'issue-102.md'),
      router,
      constitution: null,
      log: () => {},
      autoRework: false,
    });

    expect(check.passed).toBe(false);
    expect(check.summary.results.find((r) => r.checker === 'tests')?.result).toBe('FAIL');
  });

  it('emits an environment_warning when there is no leased port and the worktree runs Playwright', async () => {
    const worktree = await makeWorktreeWithFiles(103, { 'playwright.config.ts': 'export default {};\n' });
    const { router } = makeRouter();
    const logCalls: Array<[string, string]> = [];

    const check = await checkPhase({
      issue: 103,
      worktree,
      specPath: join(worktree, 'issue-103.md'),
      router,
      constitution: null,
      log: (type, msg) => logCalls.push([type, msg]),
      autoRework: false,
    });

    const warning = logCalls.find(([type]) => type === 'environment_warning');
    expect(warning).toBeDefined();
    expect(warning?.[1]).toContain('playwright.config.ts');
    expect(warning?.[1]).toContain('collide');
    expect(check).toBeDefined();
  });

  it('emits an environment_warning from a package.json e2e script when no playwright config is present', async () => {
    const worktree = await makeWorktreeWithFiles(104, {
      'package.json': JSON.stringify({ scripts: { e2e: 'playwright test' } }),
    });
    const { router } = makeRouter();
    const logCalls: Array<[string, string]> = [];

    await checkPhase({
      issue: 104,
      worktree,
      specPath: join(worktree, 'issue-104.md'),
      router,
      constitution: null,
      log: (type, msg) => logCalls.push([type, msg]),
      autoRework: false,
    });

    const warning = logCalls.find(([type]) => type === 'environment_warning');
    expect(warning).toBeDefined();
    expect(warning?.[1]).toContain("package.json script 'e2e'");
  });

  it('does not warn when appPort is set, even if the worktree runs Playwright', async () => {
    const worktree = await makeWorktreeWithFiles(105, { 'playwright.config.ts': 'export default {};\n' });
    const { router } = makeRouter();
    const logCalls: Array<[string, string]> = [];

    await checkPhase({
      issue: 105,
      worktree,
      specPath: join(worktree, 'issue-105.md'),
      router,
      constitution: null,
      log: (type, msg) => logCalls.push([type, msg]),
      appPort: 3142,
      autoRework: false,
    });

    expect(logCalls.find(([type]) => type === 'environment_warning')).toBeUndefined();
  });

  it('does not warn when the worktree shows no live-app signal', async () => {
    const { worktree, specPath } = await makeFailingWorktree();
    const { router } = makeRouter();
    const logCalls: Array<[string, string]> = [];

    await checkPhase({
      issue: 106,
      worktree,
      specPath,
      router,
      constitution: null,
      log: (type, msg) => logCalls.push([type, msg]),
      autoRework: false,
    });

    expect(logCalls.find(([type]) => type === 'environment_warning')).toBeUndefined();
  });

  it('does not throw when package.json has a malformed scripts field', async () => {
    const worktree = await makeWorktreeWithFiles(107, {
      'package.json': JSON.stringify({ scripts: { e2e: true } }),
    });
    const { router } = makeRouter();
    const logCalls: Array<[string, string]> = [];

    await expect(
      checkPhase({
        issue: 107,
        worktree,
        specPath: join(worktree, 'issue-107.md'),
        router,
        constitution: null,
        log: (type, msg) => logCalls.push([type, msg]),
        autoRework: false,
      }),
    ).resolves.toBeDefined();

    expect(logCalls.find(([type]) => type === 'environment_warning')).toBeUndefined();
  });

  it('does not throw when package.json parses to a non-object (e.g. null)', async () => {
    const worktree = await makeWorktreeWithFiles(108, { 'package.json': 'null' });
    const { router } = makeRouter();

    await expect(
      checkPhase({
        issue: 108,
        worktree,
        specPath: join(worktree, 'issue-108.md'),
        router,
        constitution: null,
        log: () => {},
        autoRework: false,
      }),
    ).resolves.toBeDefined();
  });
});

describe('checkPhase headed-mode warnings', () => {
  it('warns and records summary.warnings when playwright.config.ts forces headless: false', async () => {
    const worktree = await makeWorktreeWithFiles(109, {
      'playwright.config.ts': 'export default { use: { headless: false } };\n',
    });
    const { router } = makeRouter();
    const logCalls: Array<[string, string]> = [];

    const check = await checkPhase({
      issue: 109,
      worktree,
      specPath: join(worktree, 'issue-109.md'),
      router,
      constitution: null,
      log: (type, msg) => logCalls.push([type, msg]),
      appPort: 3142,
      autoRework: false,
    });

    const warning = logCalls.find(
      ([type, msg]) => type === 'environment_warning' && msg.includes('playwright.config.ts'),
    );
    expect(warning).toBeDefined();
    expect(warning?.[1]).toContain('headless: false');
    expect(check.summary.warnings).toEqual(['playwright.config.ts forces headless: false']);
  });

  it('warns when a package.json script passes --headed', async () => {
    const worktree = await makeWorktreeWithFiles(110, {
      'package.json': JSON.stringify({ scripts: { e2e: 'playwright test --headed' } }),
    });
    const { router } = makeRouter();
    const logCalls: Array<[string, string]> = [];

    const check = await checkPhase({
      issue: 110,
      worktree,
      specPath: join(worktree, 'issue-110.md'),
      router,
      constitution: null,
      log: (type, msg) => logCalls.push([type, msg]),
      appPort: 3142,
      autoRework: false,
    });

    const warning = logCalls.find(
      ([type, msg]) => type === 'environment_warning' && msg.includes('headed e2e config detected'),
    );
    expect(warning).toBeDefined();
    expect(warning?.[1]).toContain('--headed');
    expect(check.summary.warnings).toEqual(["package.json script 'e2e' passes --headed"]);
  });

  it("warns when a package.json script runs 'cypress open'", async () => {
    const worktree = await makeWorktreeWithFiles(111, {
      'package.json': JSON.stringify({ scripts: { cy: 'cypress open' } }),
    });
    const { router } = makeRouter();
    const logCalls: Array<[string, string]> = [];

    const check = await checkPhase({
      issue: 111,
      worktree,
      specPath: join(worktree, 'issue-111.md'),
      router,
      constitution: null,
      log: (type, msg) => logCalls.push([type, msg]),
      autoRework: false,
    });

    const warning = logCalls.find(([type, msg]) => type === 'environment_warning' && msg.includes("script 'cy'"));
    expect(warning).toBeDefined();
    expect(warning?.[1]).toContain('cypress open');
    expect(check.summary.warnings).toEqual(["package.json script 'cy' runs 'cypress open' (interactive UI runner)"]);
  });

  it('does not warn for a plain headless playwright config and script', async () => {
    const worktree = await makeWorktreeWithFiles(112, {
      'playwright.config.ts': 'export default {};\n',
      'package.json': JSON.stringify({ scripts: { e2e: 'playwright test' } }),
    });
    const { router } = makeRouter();
    const logCalls: Array<[string, string]> = [];

    const check = await checkPhase({
      issue: 112,
      worktree,
      specPath: join(worktree, 'issue-112.md'),
      router,
      constitution: null,
      log: (type, msg) => logCalls.push([type, msg]),
      appPort: 3142,
      autoRework: false,
    });

    expect(
      logCalls.find(([type, msg]) => type === 'environment_warning' && msg.includes('headed e2e config detected')),
    ).toBeUndefined();
    expect(check.summary.warnings).toBeUndefined();
  });

  it('drops the warning from the final summary once rework fixes the headed config', { timeout: 120_000 }, async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'check-phase-headed-rework-'));
    tempDirs.add(worktree);
    const marker = join(worktree, 'fixed.marker');

    await writeFixture(worktree, 'playwright.config.ts', 'export default { use: { headless: false } };\n');
    await writeFixture(
      worktree,
      'package.json',
      JSON.stringify({ scripts: { test: `node -e "process.exit(require('fs').existsSync('${marker}') ? 0 : 1)"` } }),
    );
    const specPath = join(worktree, 'issue-113.md');
    await writeFixture(worktree, 'issue-113.md', '# Spec: headed config fixed by rework\n');

    const fakeRouter = {
      run: async () => {
        await writeFile(join(worktree, 'playwright.config.ts'), 'export default { use: { headless: true } };\n');
        await writeFile(marker, '');
        return { model: 'fake-model', output: 'fixed', exitCode: 0, attempts: [] };
      },
    } as any;

    const check = await checkPhase({
      issue: 113,
      worktree,
      specPath,
      router: fakeRouter,
      constitution: null,
      log: () => {},
    });

    expect(check.passed).toBe(true);
    expect(check.reworkRounds).toBe(1);
    expect(check.summary.warnings).toBeUndefined();
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
    // design_smells fails open (SKIP) in this non-git temp worktree — it has no origin/main to diff against.
    expect(logs).toContainEqual({ type: 'check', msg: 'All checkers passed (1 skipped)' });
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
    // Also SKIPped: design_smells, fail-open in this non-git temp worktree.
    expect(logs).toContainEqual({ type: 'check', msg: 'All checkers passed (2 skipped)' });
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
    // design_smells fails open (SKIP) in this non-git temp worktree — it has no origin/main to diff against.
    expect(logs).toContainEqual({ type: 'check', msg: 'All checkers passed (1 skipped)' });
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

async function makeTestFailureEvidenceWorktree(): Promise<{ worktree: string; specPath: string }> {
  const worktree = await mkdtemp(join(tmpdir(), 'check-phase-test-evidence-'));
  tempDirs.add(worktree);
  const diagnostic = 'diagnostic output '.repeat(100);

  await writeFixture(
    worktree,
    'package.json',
    JSON.stringify({
      scripts: {
        test: `node -e "console.error('FAIL  src/phases/build.test.ts > buildPhase > uses the Codex route\\nnot ok 2 - reports the fallback warning\\nFAIL  restores the inherited environment\\nFAIL  fourth identifier is excluded\\n${diagnostic}'); process.exit(1)"`,
      },
    }),
  );

  const specPath = join(worktree, 'issue-491.md');
  await writeFixture(worktree, 'issue-491.md', '# Spec: capture test failure evidence\n');
  return { worktree, specPath };
}

async function makeLintFailingWorktree(): Promise<{ worktree: string; specPath: string }> {
  const worktree = await mkdtemp(join(tmpdir(), 'check-phase-lint-failure-'));
  tempDirs.add(worktree);

  await writeFixture(worktree, 'package.json', JSON.stringify({ scripts: { test: 'exit 0', lint: 'exit 1' } }));

  const specPath = join(worktree, 'issue-492.md');
  await writeFixture(worktree, 'issue-492.md', '# Spec: non-test failure evidence\n');
  return { worktree, specPath };
}

/** Worktree whose package.json `test` script exits 0 only when PORT/FACTORY_APP_PORT/FACTORY_BASE_URL were forwarded into its process env. */
async function makeEnvAssertingWorktree(issue: number): Promise<string> {
  const worktree = await mkdtemp(join(tmpdir(), `check-phase-env-${issue}-`));
  tempDirs.add(worktree);

  const check =
    "process.env.PORT === '3142' && process.env.FACTORY_APP_PORT === '3142' && process.env.FACTORY_BASE_URL === 'http://127.0.0.1:3142'";
  await writeFixture(
    worktree,
    'package.json',
    JSON.stringify({ scripts: { test: `node -e "process.exit(${check} ? 0 : 1)"` } }),
  );
  await writeFixture(worktree, `issue-${issue}.md`, `# Spec: env-asserting checks\n`);

  return worktree;
}

async function makeWorktreeWithFiles(issue: number, files: Record<string, string>): Promise<string> {
  const worktree = await mkdtemp(join(tmpdir(), `check-phase-files-${issue}-`));
  tempDirs.add(worktree);

  for (const [path, contents] of Object.entries(files)) {
    await writeFixture(worktree, path, contents);
  }
  await writeFixture(worktree, `issue-${issue}.md`, `# Spec: live-app signal detection\n`);

  return worktree;
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
