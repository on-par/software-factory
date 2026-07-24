import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    'pinned-model': {
      provider: 'custom',
      tier: 'worker',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
    },
  },
  tiers: { worker: ['stub-codex', 'stub-worker', 'pinned-model'] },
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
  await Promise.all([...tempDirs].map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.clear();
});

describe('buildPhase FACTORY_CODEX kill-switch', () => {
  let prevFactoryCodex: string | undefined;

  beforeEach(() => {
    prevFactoryCodex = process.env.FACTORY_CODEX;
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
      constitution: null,
      log: (type, msg) => {
        logs.push({ type, msg });
      },
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
      constitution: null,
      log: (type, msg) => {
        logs.push({ type, msg });
      },
    });

    expect(result.ok).toBe(true);
    expect(stub.calls[stub.calls.length - 1].task).toBe('build_codex');
    expect(logs.some((l) => l.type === 'warn')).toBe(false);
  });

  it('forces build_claude via the codexDisabled opt with no env var set', async () => {
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
      branch: 'ship-it/79-repo-config-codex-kill-switch',
      route: 'codex',
      router,
      constitution: null,
      log: (type, msg) => {
        logs.push({ type, msg });
      },
      codexDisabled: true,
    });

    expect(result.ok).toBe(true);
    expect(stub.calls[stub.calls.length - 1].task).toBe('build_claude');
    expect(logs).toContainEqual({ type: 'warn', msg: 'codex unavailable — falling back to claude' });
  });

  it('preserves FACTORY_CODEX=0 behavior when the codexDisabled opt is omitted', async () => {
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
      constitution: null,
      log: (type, msg) => {
        logs.push({ type, msg });
      },
    });

    expect(result.ok).toBe(true);
    expect(stub.calls[stub.calls.length - 1].task).toBe('build_claude');
    expect(logs).toContainEqual({ type: 'warn', msg: 'codex unavailable — falling back to claude' });
  });
});

describe('buildPhase local-only codex prompt', () => {
  let prevLocalOnly: string | undefined;

  beforeEach(() => {
    prevLocalOnly = process.env.FACTORY_LOCAL_ONLY;
    process.env.FACTORY_LOCAL_ONLY = '1';
  });

  afterEach(() => {
    if (prevLocalOnly === undefined) delete process.env.FACTORY_LOCAL_ONLY;
    else process.env.FACTORY_LOCAL_ONLY = prevLocalOnly;
  });

  it('sends the compact local-small prompt with the trimmed spec', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'build-phase-test-'));
    tempDirs.add(worktree);
    const specPath = join(worktree, 'issue-82.md');
    await writeFile(specPath, '   # Frozen spec 82\nDo the small thing.   \n');

    const stub = new StubModelExecutor({ scripts: { build_codex: [{ output: 'codex output' }] } });
    // Force the router itself out of local-only mode so the stub models still
    // resolve; buildPhase reads FACTORY_LOCAL_ONLY directly for prompt shaping.
    const router = new ModelRouter(models, routes, false, stub, false, false);

    const result = await buildPhase({
      issue: 82,
      repo: 'on-par/software-factory',
      worktree,
      specPath,
      branch: 'ship-it/82-local-small',
      route: 'codex',
      router,
      constitution: null,
      log: () => {},
    });

    expect(result.ok).toBe(true);
    const prompt = stub.calls[stub.calls.length - 1].prompt;
    expect(stub.calls[stub.calls.length - 1].task).toBe('build_codex');
    expect(prompt).toContain('Local-small build for issue #82.');
    // Spec is trimmed (leading/trailing whitespace removed) and inlined.
    expect(prompt).toContain('# Frozen spec 82');
    expect(prompt).not.toContain('   # Frozen spec 82');
    expect(prompt).not.toContain('[truncated for local model');
  });

  it('truncates an oversized spec for the local model', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'build-phase-test-'));
    tempDirs.add(worktree);
    const specPath = join(worktree, 'issue-83.md');
    const bigSpec = 'x'.repeat(7000);
    await writeFile(specPath, bigSpec);

    const stub = new StubModelExecutor({ scripts: { build_codex: [{ output: 'codex output' }] } });
    const router = new ModelRouter(models, routes, false, stub, false, false);

    const result = await buildPhase({
      issue: 83,
      repo: 'on-par/software-factory',
      worktree,
      specPath,
      branch: 'ship-it/83-big-spec',
      route: 'codex',
      router,
      constitution: null,
      log: () => {},
    });

    expect(result.ok).toBe(true);
    const prompt = stub.calls[stub.calls.length - 1].prompt;
    expect(prompt).toContain(
      '[truncated for local model: keep the implementation minimal and inspect files as needed]',
    );
    // Only the first 5600 chars of the spec are retained before the truncation note.
    expect(prompt).toContain('x'.repeat(5600));
    expect(prompt).not.toContain('x'.repeat(6001));
  });
});

describe('buildPhase escalation', () => {
  it('returns not-ok and surfaces the ESCALATE line when the worker escalates', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'build-phase-test-'));
    tempDirs.add(worktree);
    const specPath = join(worktree, 'issue-84.md');
    const stub = new StubModelExecutor({
      scripts: {
        build_claude: [{ output: 'progress line\nESCALATE: the acceptance criteria are ambiguous\nmore text' }],
      },
    });
    const router = new ModelRouter(models, routes, false, stub);
    const logs: Array<{ type: string; msg: string }> = [];

    const result = await buildPhase({
      issue: 84,
      repo: 'on-par/software-factory',
      worktree,
      specPath,
      branch: 'ship-it/84-ambiguous',
      route: 'claude',
      router,
      constitution: null,
      log: (type, msg) => {
        logs.push({ type, msg });
      },
    });

    expect(result.ok).toBe(false);
    expect(result.escalate).toBe('ESCALATE: the acceptance criteria are ambiguous');
    expect(logs).toContainEqual({ type: 'escalate', msg: 'ESCALATE: the acceptance criteria are ambiguous' });
  });

  it('includes the skip-CI guidance in the claude prompt when skipCI is set', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'build-phase-test-'));
    tempDirs.add(worktree);
    const specPath = join(worktree, 'issue-85.md');
    const stub = new StubModelExecutor({ scripts: { build_claude: [{ output: 'ready for review' }] } });
    const router = new ModelRouter(models, routes, false, stub);

    const result = await buildPhase({
      issue: 85,
      repo: 'on-par/software-factory',
      worktree,
      specPath,
      branch: 'ship-it/85-skip-ci',
      route: 'claude',
      router,
      constitution: null,
      log: () => {},
      skipCI: true,
    });

    expect(result.ok).toBe(true);
    expect(stub.calls[stub.calls.length - 1].prompt).toContain('CI is intentionally skipped');
  });
});

describe('buildPhase modelOverride', () => {
  it('uses the default tier-order model when no modelOverride is given', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'build-phase-test-'));
    tempDirs.add(worktree);
    const specPath = join(worktree, 'issue-80.md');
    const stub = new StubModelExecutor({
      scripts: {
        build_claude: [{ output: 'claude output' }],
      },
    });
    const router = new ModelRouter(models, routes, false, stub);

    const result = await buildPhase({
      issue: 80,
      repo: 'on-par/software-factory',
      worktree,
      specPath,
      branch: 'ship-it/80-add-model-override',
      route: 'claude',
      router,
      constitution: null,
      log: () => {},
    });

    expect(result.ok).toBe(true);
    expect(stub.calls[0].model).toBe(router.resolveAll('build_claude')[0]);
  });

  it('pins the build model via modelOverride, bypassing default tier order', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'build-phase-test-'));
    tempDirs.add(worktree);
    const specPath = join(worktree, 'issue-81.md');
    const stub = new StubModelExecutor({
      scripts: {
        build_claude: [{ output: 'claude output' }],
      },
    });
    const router = new ModelRouter(models, routes, false, stub);

    const result = await buildPhase({
      issue: 81,
      repo: 'on-par/software-factory',
      worktree,
      specPath,
      branch: 'ship-it/81-add-model-override',
      route: 'claude',
      router,
      constitution: null,
      log: () => {},
      modelOverride: 'pinned-model',
    });

    expect(result.ok).toBe(true);
    expect(stub.calls[0].model).toBe('pinned-model');
  });
});

describe('buildPhase sandbox', () => {
  it('logs the sandbox start event and forwards the policy + onSandboxEvent to router.run', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'build-phase-test-'));
    tempDirs.add(worktree);
    const specPath = join(worktree, 'issue-91.md');
    const sandbox: SandboxPolicy = {
      runtime: 'sandbox-exec',
      worktree,
      writablePaths: [worktree],
      allowHosts: [],
      cpuMs: 300_000,
      memMb: 4096,
    };
    const captured: { options?: any } = {};
    const fakeRouter = {
      run: async (_task: string, _prompt: string, options: any) => {
        captured.options = options;
        return { model: 'fake-model', output: 'done', exitCode: 0, attempts: [] };
      },
    } as any;
    const logs: Array<{ type: string; msg: string }> = [];

    const result = await buildPhase({
      issue: 91,
      repo: 'on-par/software-factory',
      worktree,
      specPath,
      branch: 'ship-it/91-sandbox',
      route: 'claude',
      router: fakeRouter,
      constitution: null,
      log: (type, msg) => {
        logs.push({ type, msg });
      },
      sandbox,
    });

    expect(result.ok).toBe(true);
    expect(logs).toContainEqual({ type: 'sandbox', msg: 'containment active (runtime sandbox-exec, net deny-all)' });
    expect(captured.options.sandbox).toBe(sandbox);
    expect(typeof captured.options.onSandboxEvent).toBe('function');

    captured.options.onSandboxEvent('sandbox_violation', 'Operation not permitted');
    expect(logs).toContainEqual({ type: 'sandbox_violation', msg: 'Operation not permitted' });
  });

  it('logs an allow-list sandbox start event when the policy grants allowHosts', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'build-phase-test-'));
    tempDirs.add(worktree);
    const specPath = join(worktree, 'issue-93.md');
    const sandbox: SandboxPolicy = {
      runtime: 'sandbox-exec',
      worktree,
      writablePaths: [worktree],
      allowHosts: ['example.com'],
      cpuMs: 300_000,
      memMb: 4096,
    };
    const stub = new StubModelExecutor({ scripts: { build_claude: [{ output: 'claude output' }] } });
    const router = new ModelRouter(models, routes, false, stub);
    const logs: Array<{ type: string; msg: string }> = [];

    const result = await buildPhase({
      issue: 93,
      repo: 'on-par/software-factory',
      worktree,
      specPath,
      branch: 'ship-it/93-sandbox-allow-list',
      route: 'claude',
      router,
      constitution: null,
      log: (type, msg) => {
        logs.push({ type, msg });
      },
      sandbox,
    });

    expect(result.ok).toBe(true);
    expect(logs).toContainEqual({ type: 'sandbox', msg: 'containment active (runtime sandbox-exec, net allow-list)' });
  });

  it('does not log a sandbox start event when no sandbox policy is set', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'build-phase-test-'));
    tempDirs.add(worktree);
    const specPath = join(worktree, 'issue-92.md');
    const stub = new StubModelExecutor({ scripts: { build_claude: [{ output: 'claude output' }] } });
    const router = new ModelRouter(models, routes, false, stub);
    const logs: Array<{ type: string; msg: string }> = [];

    await buildPhase({
      issue: 92,
      repo: 'on-par/software-factory',
      worktree,
      specPath,
      branch: 'ship-it/92-no-sandbox',
      route: 'claude',
      router,
      constitution: null,
      log: (type, msg) => {
        logs.push({ type, msg });
      },
    });

    expect(logs.some((l) => l.type === 'sandbox')).toBe(false);
  });
});

describe('buildPhase steering', () => {
  it('appends the operator guidance block to the claude route prompt when steering is passed', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'build-phase-test-'));
    tempDirs.add(worktree);
    const specPath = join(worktree, 'issue-93.md');
    const stub = new StubModelExecutor({ scripts: { build_claude: [{ output: 'claude output' }] } });
    const router = new ModelRouter(models, routes, false, stub);

    const result = await buildPhase({
      issue: 93,
      repo: 'on-par/software-factory',
      worktree,
      specPath,
      branch: 'ship-it/93-steering',
      route: 'claude',
      router,
      constitution: null,
      log: () => {},
      steering: {
        messages: [{ id: '1', issue: 93, text: 'prefer the simpler fix', queuedAt: '2026-01-01T00:00:00.000Z' }],
        attachments: [],
      },
    });

    expect(result.ok).toBe(true);
    const prompt = stub.calls[stub.calls.length - 1].prompt;
    expect(prompt).toContain('## Operator guidance (steering)');
    expect(prompt).toContain('prefer the simpler fix');
  });

  it('appends the operator guidance block to the codex route prompt when steering is passed', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'build-phase-test-'));
    tempDirs.add(worktree);
    const specPath = join(worktree, 'issue-94.md');
    const stub = new StubModelExecutor({ scripts: { build_codex: [{ output: 'codex output' }] } });
    const router = new ModelRouter(models, routes, false, stub);

    const result = await buildPhase({
      issue: 94,
      repo: 'on-par/software-factory',
      worktree,
      specPath,
      branch: 'ship-it/94-steering',
      route: 'codex',
      router,
      constitution: null,
      log: () => {},
      steering: {
        messages: [{ id: '1', issue: 94, text: 'watch out for the flaky test', queuedAt: '2026-01-01T00:00:00.000Z' }],
        attachments: [],
      },
    });

    expect(result.ok).toBe(true);
    const prompt = stub.calls[stub.calls.length - 1].prompt;
    expect(prompt).toContain('## Operator guidance (steering)');
    expect(prompt).toContain('watch out for the flaky test');
  });

  it('leaves the prompt unchanged (no steering block) when no steering is passed', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'build-phase-test-'));
    tempDirs.add(worktree);
    const specPath = join(worktree, 'issue-95.md');
    const stub = new StubModelExecutor({ scripts: { build_claude: [{ output: 'claude output' }] } });
    const router = new ModelRouter(models, routes, false, stub);

    await buildPhase({
      issue: 95,
      repo: 'on-par/software-factory',
      worktree,
      specPath,
      branch: 'ship-it/95-no-steering',
      route: 'claude',
      router,
      constitution: null,
      log: () => {},
    });

    const prompt = stub.calls[stub.calls.length - 1].prompt;
    expect(prompt).not.toContain('## Operator guidance (steering)');
  });
});

describe('buildPhase failover events', () => {
  it('emits a structured failover event when the router fails over to a different model', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'build-phase-test-'));
    tempDirs.add(worktree);
    const specPath = join(worktree, 'issue-90.md');
    const stub = new StubModelExecutor({
      scripts: {
        build_claude: [{ fail: 'usage_cap' }, { output: 'claude output' }],
      },
    });
    const router = new ModelRouter(models, routes, false, stub);
    const logCalls: Array<[string, string, ({ failoverReason?: string } | undefined)?]> = [];

    const result = await buildPhase({
      issue: 90,
      repo: 'on-par/software-factory',
      worktree,
      specPath,
      branch: 'ship-it/90-failover',
      route: 'claude',
      router,
      constitution: null,
      log: (type, msg, extra) => {
        logCalls.push([type, msg, extra]);
      },
    });

    expect(result.ok).toBe(true);
    expect(logCalls).toContainEqual([
      'failover',
      expect.stringContaining('usage_cap'),
      { failoverReason: 'usage_cap' },
    ]);
  });

  it('omits the detail suffix from the failover log when the failed attempt carries no descriptive detail', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'build-phase-test-'));
    tempDirs.add(worktree);
    const specPath = join(worktree, 'issue-93.md');
    let calls = 0;
    const executor = {
      async runModel() {
        calls++;
        if (calls === 1) throw new Error('');
        return 'claude output';
      },
    };
    const router = new ModelRouter(models, routes, false, executor as any);
    const logCalls: Array<[string, string, ({ failoverReason?: string } | undefined)?]> = [];

    const result = await buildPhase({
      issue: 94,
      repo: 'on-par/software-factory',
      worktree,
      specPath,
      branch: 'ship-it/94-no-detail-failover',
      route: 'claude',
      router,
      constitution: null,
      log: (type, msg, extra) => {
        logCalls.push([type, msg, extra]);
      },
    });

    expect(result.ok).toBe(true);
    const failoverLog = logCalls.find(([type]) => type === 'failover');
    expect(failoverLog?.[1]).toMatch(/failed \(unknown\) — failed over$/);
  });
});

describe('buildPhase timeoutSeconds', () => {
  it('forwards a custom timeoutSeconds to router.run instead of the 7200s default', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'build-phase-test-'));
    tempDirs.add(worktree);
    const specPath = join(worktree, 'issue-95.md');
    const captured: { options?: any } = {};
    const fakeRouter = {
      run: async (_task: string, _prompt: string, options: any) => {
        captured.options = options;
        return { model: 'fake-model', output: 'done', exitCode: 0, attempts: [] };
      },
    } as any;

    const result = await buildPhase({
      issue: 95,
      repo: 'on-par/software-factory',
      worktree,
      specPath,
      branch: 'ship-it/95-timeout',
      route: 'claude',
      router: fakeRouter,
      constitution: null,
      log: () => {},
      timeoutSeconds: 123,
    });

    expect(result.ok).toBe(true);
    expect(captured.options.timeoutSeconds).toBe(123);
  });
});

describe('buildPhase appPort', () => {
  let prevFactoryHeadless: string | undefined;

  beforeEach(() => {
    prevFactoryHeadless = process.env.FACTORY_HEADLESS;
    delete process.env.FACTORY_HEADLESS;
  });

  afterEach(() => {
    if (prevFactoryHeadless === undefined) delete process.env.FACTORY_HEADLESS;
    else process.env.FACTORY_HEADLESS = prevFactoryHeadless;
  });

  it('injects laneEnv and the port prompt block on the codex route when appPort is set', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'build-phase-test-'));
    tempDirs.add(worktree);
    const specPath = join(worktree, 'issue-96.md');
    const captured: { options?: any; prompt?: string } = {};
    const fakeRouter = {
      run: async (_task: string, prompt: string, options: any) => {
        captured.options = options;
        captured.prompt = prompt;
        return { model: 'fake-model', output: 'done', exitCode: 0, attempts: [] };
      },
    } as any;

    const result = await buildPhase({
      issue: 96,
      repo: 'on-par/software-factory',
      worktree,
      specPath,
      branch: 'ship-it/96-appport',
      route: 'codex',
      router: fakeRouter,
      constitution: null,
      log: () => {},
      appPort: 3142,
    });

    expect(result.ok).toBe(true);
    expect(captured.options.env).toEqual({
      FACTORY_HEADLESS: '1',
      PLAYWRIGHT_HEADLESS: '1',
      PORT: '3142',
      FACTORY_APP_PORT: '3142',
      FACTORY_BASE_URL: 'http://127.0.0.1:3142',
    });
    expect(captured.prompt).toContain('3142');
    expect(captured.prompt).toContain('http://127.0.0.1:3142');
    expect(captured.prompt).toContain('--strictPort');
    expect(captured.prompt).toContain('## Headless e2e');
    expect(captured.prompt).toContain('--headed');
  });

  it('injects laneEnv and the port prompt block on the claude route when appPort is set', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'build-phase-test-'));
    tempDirs.add(worktree);
    const specPath = join(worktree, 'issue-97.md');
    const captured: { options?: any; prompt?: string } = {};
    const fakeRouter = {
      run: async (_task: string, prompt: string, options: any) => {
        captured.options = options;
        captured.prompt = prompt;
        return { model: 'fake-model', output: 'done', exitCode: 0, attempts: [] };
      },
    } as any;

    const result = await buildPhase({
      issue: 97,
      repo: 'on-par/software-factory',
      worktree,
      specPath,
      branch: 'ship-it/97-appport',
      route: 'claude',
      router: fakeRouter,
      constitution: null,
      log: () => {},
      appPort: 3142,
    });

    expect(result.ok).toBe(true);
    expect(captured.options.env).toEqual({
      FACTORY_HEADLESS: '1',
      PLAYWRIGHT_HEADLESS: '1',
      PORT: '3142',
      FACTORY_APP_PORT: '3142',
      FACTORY_BASE_URL: 'http://127.0.0.1:3142',
    });
    expect(captured.prompt).toContain('3142');
    expect(captured.prompt).toContain('http://127.0.0.1:3142');
    expect(captured.prompt).toContain('--strictPort');
    expect(captured.prompt).toContain('## Headless e2e');
    expect(captured.prompt).toContain('--headed');
  });

  it('carries headless-only env and no port prompt block when appPort is unset', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'build-phase-test-'));
    tempDirs.add(worktree);
    const specPath = join(worktree, 'issue-98.md');
    const captured: { options?: any; prompt?: string } = {};
    const fakeRouter = {
      run: async (_task: string, prompt: string, options: any) => {
        captured.options = options;
        captured.prompt = prompt;
        return { model: 'fake-model', output: 'done', exitCode: 0, attempts: [] };
      },
    } as any;

    const result = await buildPhase({
      issue: 98,
      repo: 'on-par/software-factory',
      worktree,
      specPath,
      branch: 'ship-it/98-no-appport',
      route: 'claude',
      router: fakeRouter,
      constitution: null,
      log: () => {},
    });

    expect(result.ok).toBe(true);
    expect(captured.options.env).toEqual({ FACTORY_HEADLESS: '1', PLAYWRIGHT_HEADLESS: '1' });
    expect(captured.prompt).not.toContain('Assigned app port');
    expect(captured.prompt).toContain('## Headless e2e');
  });
});

describe('buildPhase cross-harness failover', () => {
  const failoverModels: ModelsConfig = {
    version: 1,
    models: {
      'codex-a': {
        provider: 'openai',
        tier: 'worker',
        costPerMtokInput: 0,
        costPerMtokOutput: 0,
        contextWindow: 1000,
        capabilities: ['codex'],
        envKey: null,
        codex: true,
        harness: 'codex-cli',
      },
      'codex-b': {
        provider: 'openai',
        tier: 'worker',
        costPerMtokInput: 0,
        costPerMtokOutput: 0,
        contextWindow: 1000,
        capabilities: ['codex'],
        envKey: null,
        codex: true,
        harness: 'codex-cli',
      },
      'claude-sonnet-5': {
        provider: 'anthropic',
        tier: 'worker',
        costPerMtokInput: 0,
        costPerMtokOutput: 0,
        contextWindow: 1000,
        capabilities: [],
        envKey: null,
        harness: 'claude-cli',
      },
    },
    tiers: { worker: ['codex-a', 'codex-b', 'claude-sonnet-5'] },
    failover: {
      triggers: ['rate_limit', 'usage_cap', 'timeout', 'error', 'empty_response'],
      maxRetries: 2,
      cooldownMs: 0,
      escalateAfterTierExhausted: true,
    },
    routingRules: {},
  };
  const failoverRoutes: RoutesConfig = {
    version: 1,
    routes: {
      build_codex: { tier: 'worker', description: 'stub', requires: 'codex' },
      build_claude: { tier: 'worker', description: 'stub', requires: 'claude' },
    },
  };

  it('continues a codex build on claude when every codex worker is quota-exhausted', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'build-phase-test-'));
    tempDirs.add(worktree);
    const specPath = join(worktree, 'issue-367.md');
    const stub = new StubModelExecutor({
      scripts: {
        build_codex: [{ fail: 'usage_cap' }, { fail: 'usage_cap' }],
        build_claude: [{ output: 'claude output' }],
      },
    });
    const router = new ModelRouter(failoverModels, failoverRoutes, false, stub);
    const logCalls: Array<[string, string, ({ failoverReason?: string } | undefined)?]> = [];

    const result = await buildPhase({
      issue: 367,
      repo: 'on-par/software-factory',
      worktree,
      specPath,
      branch: 'ship-it/367-cross-harness-build-failover',
      route: 'codex',
      router,
      constitution: null,
      log: (type, msg, extra) => {
        logCalls.push([type, msg, extra]);
      },
    });

    expect(result.ok).toBe(true);
    expect(result.model).toBe('claude-sonnet-5');
    expect(stub.calls.map((c) => ({ model: c.model, task: c.task }))).toEqual([
      { model: 'codex-a', task: 'build_codex' },
      { model: 'codex-b', task: 'build_codex' },
      { model: 'claude-sonnet-5', task: 'build_claude' },
    ]);
    expect(logCalls).toContainEqual([
      'worker_failover',
      expect.stringMatching(
        /^Codex build workers exhausted \(usage_cap\) — continuing on claude: from_model=codex-b to_model=claude-sonnet-5 from_route=build_codex to_route=build_claude reason=usage_cap$/,
      ),
      { failoverReason: 'usage_cap' },
    ]);
  });

  it('tags the claude fallback run with retryCause: failover on the cost row', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'build-phase-test-'));
    tempDirs.add(worktree);
    const specPath = join(worktree, 'issue-367.md');
    const stub = new StubModelExecutor({
      scripts: {
        build_codex: [{ fail: 'usage_cap' }, { fail: 'usage_cap' }],
        build_claude: [{ output: 'claude output' }],
      },
    });
    const router = new ModelRouter(failoverModels, failoverRoutes, false, stub);
    const costRows: Array<{ task: string; retryCause?: string }> = [];
    router.setCostSink((entry) => costRows.push(entry));

    await buildPhase({
      issue: 367,
      repo: 'on-par/software-factory',
      worktree,
      specPath,
      branch: 'ship-it/367-cross-harness-build-failover',
      route: 'codex',
      router,
      constitution: null,
      log: () => {},
    });

    expect(costRows).toHaveLength(1);
    expect(costRows[0].task).toBe('build_claude');
    expect(costRows[0].retryCause).toBe('failover');
  });

  it('passes no retryCause on the cost row for a plain, non-fallback build run', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'build-phase-test-'));
    tempDirs.add(worktree);
    const specPath = join(worktree, 'issue-367.md');
    const stub = new StubModelExecutor({ scripts: { build_codex: [{ output: 'codex output' }] } });
    const router = new ModelRouter(failoverModels, failoverRoutes, false, stub);
    const costRows: Array<{ task: string; retryCause?: string }> = [];
    router.setCostSink((entry) => costRows.push(entry));

    await buildPhase({
      issue: 367,
      repo: 'on-par/software-factory',
      worktree,
      specPath,
      branch: 'ship-it/367-cross-harness-build-failover',
      route: 'codex',
      router,
      constitution: null,
      log: () => {},
    });

    expect(costRows).toHaveLength(1);
    expect(costRows[0].task).toBe('build_codex');
    expect('retryCause' in costRows[0]).toBe(false);
  });

  it('continues a codex build on claude when every codex worker is rate-limited', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'build-phase-test-'));
    tempDirs.add(worktree);
    const specPath = join(worktree, 'issue-367.md');
    const stub = new StubModelExecutor({
      scripts: {
        build_codex: [{ fail: 'rate_limit' }, { fail: 'rate_limit' }, { fail: 'rate_limit' }],
        build_claude: [{ output: 'claude output' }],
      },
    });
    // maxRetries: 0 so a rate_limit fails over immediately instead of retrying the same model.
    const rateLimitModels: ModelsConfig = {
      ...failoverModels,
      failover: { ...failoverModels.failover, maxRetries: 0 },
    };
    const router = new ModelRouter(rateLimitModels, failoverRoutes, false, stub);
    const logCalls: Array<[string, string, ({ failoverReason?: string } | undefined)?]> = [];

    const result = await buildPhase({
      issue: 367,
      repo: 'on-par/software-factory',
      worktree,
      specPath,
      branch: 'ship-it/367-cross-harness-build-failover',
      route: 'codex',
      router,
      constitution: null,
      log: (type, msg, extra) => {
        logCalls.push([type, msg, extra]);
      },
    });

    expect(result.ok).toBe(true);
    expect(result.model).toBe('claude-sonnet-5');
    expect(logCalls.some(([type]) => type === 'worker_failover')).toBe(true);
  });

  it('does not swap harnesses for a non-quota failure — the lane still parks', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'build-phase-test-'));
    tempDirs.add(worktree);
    const specPath = join(worktree, 'issue-367.md');
    const stub = new StubModelExecutor({
      scripts: {
        build_codex: [{ fail: 'error' }, { fail: 'error' }],
        build_claude: [{ output: 'claude output' }],
      },
    });
    const router = new ModelRouter(failoverModels, failoverRoutes, false, stub);
    const logCalls: Array<[string, string, ({ failoverReason?: string } | undefined)?]> = [];

    await expect(
      buildPhase({
        issue: 367,
        repo: 'on-par/software-factory',
        worktree,
        specPath,
        branch: 'ship-it/367-cross-harness-build-failover',
        route: 'codex',
        router,
        constitution: null,
        log: (type, msg, extra) => {
          logCalls.push([type, msg, extra]);
        },
      }),
    ).rejects.toThrow(/All models failed for task 'build_codex'/);

    expect(stub.calls.some((c) => c.task === 'build_claude')).toBe(false);
    expect(logCalls.some(([type]) => type === 'worker_failover')).toBe(false);
  });

  it('re-throws when the claude fallback re-run itself fails', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'build-phase-test-'));
    tempDirs.add(worktree);
    const specPath = join(worktree, 'issue-367.md');
    const stub = new StubModelExecutor({
      scripts: {
        build_codex: [{ fail: 'usage_cap' }, { fail: 'usage_cap' }],
        build_claude: [{ fail: 'error' }, { fail: 'error' }],
      },
    });
    const router = new ModelRouter(failoverModels, failoverRoutes, false, stub);

    await expect(
      buildPhase({
        issue: 367,
        repo: 'on-par/software-factory',
        worktree,
        specPath,
        branch: 'ship-it/367-cross-harness-build-failover',
        route: 'codex',
        router,
        constitution: null,
        log: () => {},
      }),
    ).rejects.toThrow(/All models failed for task 'build_claude'/);
  });

  it('autoFailover.enabled: false rethrows the quota error without touching claude', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'build-phase-test-'));
    tempDirs.add(worktree);
    const specPath = join(worktree, 'issue-367.md');
    const stub = new StubModelExecutor({
      scripts: {
        build_codex: [{ fail: 'usage_cap' }, { fail: 'usage_cap' }],
        build_claude: [{ output: 'claude output' }],
      },
    });
    const router = new ModelRouter(failoverModels, failoverRoutes, false, stub);
    const logCalls: Array<[string, string]> = [];

    await expect(
      buildPhase({
        issue: 367,
        repo: 'on-par/software-factory',
        worktree,
        specPath,
        branch: 'ship-it/367-cross-harness-build-failover',
        route: 'codex',
        router,
        constitution: null,
        log: (type, msg) => {
          logCalls.push([type, msg]);
        },
        autoFailover: { enabled: false },
      }),
    ).rejects.toThrow(/All models failed for task 'build_codex'/);

    expect(stub.calls.every((c) => c.task === 'build_codex')).toBe(true);
    expect(logCalls.some(([type]) => type === 'worker_failover')).toBe(false);
  });

  it('autoFailover.enabled: true calls onQuotaExhausted exactly once with provider and reason', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'build-phase-test-'));
    tempDirs.add(worktree);
    const specPath = join(worktree, 'issue-367.md');
    const stub = new StubModelExecutor({
      scripts: {
        build_codex: [{ fail: 'usage_cap' }, { fail: 'usage_cap' }],
        build_claude: [{ output: 'claude output' }],
      },
    });
    const router = new ModelRouter(failoverModels, failoverRoutes, false, stub);
    const onQuotaExhausted = vi.fn();

    const result = await buildPhase({
      issue: 367,
      repo: 'on-par/software-factory',
      worktree,
      specPath,
      branch: 'ship-it/367-cross-harness-build-failover',
      route: 'codex',
      router,
      constitution: null,
      log: () => {},
      autoFailover: { enabled: true, onQuotaExhausted },
    });

    expect(result.ok).toBe(true);
    expect(onQuotaExhausted).toHaveBeenCalledTimes(1);
    expect(onQuotaExhausted).toHaveBeenCalledWith({ provider: 'openai', reason: 'usage_cap' });
  });

  it('still completes the claude fallback when onQuotaExhausted itself throws', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'build-phase-test-'));
    tempDirs.add(worktree);
    const specPath = join(worktree, 'issue-367.md');
    const stub = new StubModelExecutor({
      scripts: {
        build_codex: [{ fail: 'usage_cap' }, { fail: 'usage_cap' }],
        build_claude: [{ output: 'claude output' }],
      },
    });
    const router = new ModelRouter(failoverModels, failoverRoutes, false, stub);
    const logCalls: Array<[string, string]> = [];

    const result = await buildPhase({
      issue: 367,
      repo: 'on-par/software-factory',
      worktree,
      specPath,
      branch: 'ship-it/367-cross-harness-build-failover',
      route: 'codex',
      router,
      constitution: null,
      log: (type, msg) => {
        logCalls.push([type, msg]);
      },
      autoFailover: {
        enabled: true,
        onQuotaExhausted: async () => {
          throw new Error('breaker file write failed');
        },
      },
    });

    expect(result.ok).toBe(true);
    expect(result.model).toBe('claude-sonnet-5');
    expect(logCalls.some(([type, msg]) => type === 'warn' && msg.includes('breaker file write failed'))).toBe(true);
  });

  it('routes to a fallbackModel when it is an available build_claude worker', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'build-phase-test-'));
    tempDirs.add(worktree);
    const specPath = join(worktree, 'issue-367.md');
    const modelsWithSecondClaude: ModelsConfig = {
      ...failoverModels,
      models: {
        ...failoverModels.models,
        'claude-haiku': {
          provider: 'anthropic',
          tier: 'worker',
          costPerMtokInput: 0,
          costPerMtokOutput: 0,
          contextWindow: 1000,
          capabilities: [],
          envKey: null,
          harness: 'claude-cli',
        },
      },
      tiers: { worker: ['codex-a', 'codex-b', 'claude-haiku', 'claude-sonnet-5'] },
    };
    const stub = new StubModelExecutor({
      scripts: {
        build_codex: [{ fail: 'usage_cap' }, { fail: 'usage_cap' }],
        build_claude: [{ output: 'claude output' }],
      },
    });
    const router = new ModelRouter(modelsWithSecondClaude, failoverRoutes, false, stub);

    const result = await buildPhase({
      issue: 367,
      repo: 'on-par/software-factory',
      worktree,
      specPath,
      branch: 'ship-it/367-cross-harness-build-failover',
      route: 'codex',
      router,
      constitution: null,
      log: () => {},
      autoFailover: { enabled: true, fallbackModel: 'claude-haiku' },
    });

    expect(result.ok).toBe(true);
    expect(result.model).toBe('claude-haiku');
    expect(stub.calls.at(-1)).toMatchObject({ model: 'claude-haiku', task: 'build_claude' });
  });

  it('falls back to the default build_claude worker when fallbackModel is unknown', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'build-phase-test-'));
    tempDirs.add(worktree);
    const specPath = join(worktree, 'issue-367.md');
    const stub = new StubModelExecutor({
      scripts: {
        build_codex: [{ fail: 'usage_cap' }, { fail: 'usage_cap' }],
        build_claude: [{ output: 'claude output' }],
      },
    });
    const router = new ModelRouter(failoverModels, failoverRoutes, false, stub);

    const result = await buildPhase({
      issue: 367,
      repo: 'on-par/software-factory',
      worktree,
      specPath,
      branch: 'ship-it/367-cross-harness-build-failover',
      route: 'codex',
      router,
      constitution: null,
      log: () => {},
      autoFailover: { enabled: true, fallbackModel: 'nonexistent-model' },
    });

    expect(result.ok).toBe(true);
    expect(result.model).toBe('claude-sonnet-5');
    expect(stub.calls.at(-1)).toMatchObject({ model: 'claude-sonnet-5', task: 'build_claude' });
  });
});
