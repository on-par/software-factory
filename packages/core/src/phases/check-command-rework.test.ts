import { workKeyFromIssue } from '../work/work-key.js';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { CliModelExecutor, ModelRouter } from '../router/index.js';
import { StubModelExecutor } from '../router/stub.js';
import type { SandboxPolicy } from '../sandbox/index.js';
import type { CheckSummary } from '../types/index.js';
import { checkPhase, reworkWorker } from './check.js';
import { runnableBuildRoutes } from './plan-routes.js';

const failover: ModelsConfig['failover'] = {
  triggers: ['rate_limit', 'unavailable', 'auth'],
  maxRetries: 2,
  cooldownMs: 0,
};

const commandModels: ModelsConfig = {
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
  failover,
  routingRules: {},
  harnesses: {
    'my-agent': { command: 'my-agent {model}', prompt: 'stdin', output: 'stdout', agentic: true, usage: 'none' },
  },
};

const commandRoutes: RoutesConfig = {
  version: 1,
  routes: {
    build_claude: { tier: 'worker', description: 'stub', requires: 'claude' },
    build_codex: { tier: 'worker', description: 'stub', requires: 'codex' },
    build_command: { tier: 'worker', description: 'stub', requires: 'command' },
  },
};

const codexModels: ModelsConfig = {
  version: 1,
  models: {
    'codex-worker': {
      provider: 'openai',
      tier: 'boss',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: ['codex'],
      envKey: null,
      codex: true,
    },
    'claude-worker': {
      provider: 'anthropic',
      tier: 'boss',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: ['claude'],
      envKey: null,
    },
  },
  tiers: { boss: ['codex-worker', 'claude-worker'] },
  failover,
  routingRules: {},
};

const codexRoutes: RoutesConfig = {
  version: 1,
  routes: {
    build_codex: { tier: 'boss', description: 'codex', requires: 'codex' },
    build_claude: { tier: 'boss', description: 'claude', requires: 'claude' },
  },
};

const tempDirs = new Set<string>();

afterEach(async () => {
  await Promise.all([...tempDirs].map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.clear();
});

async function makeFailingWorktree(): Promise<{ worktree: string; specPath: string }> {
  const worktree = await mkdtemp(join(tmpdir(), 'check-command-rework-'));
  tempDirs.add(worktree);
  await writeFile(join(worktree, 'package.json'), JSON.stringify({ scripts: { test: 'exit 1' } }));
  const specPath = join(worktree, 'issue-2873.md');
  await writeFile(specPath, '# Spec: failing checks\n');
  return { worktree, specPath };
}

describe('checkPhase auto rework on the command route (#2873)', () => {
  it(
    'keeps rework on the command route with the pinned declared-harness model (#2873)',
    { timeout: 120_000 },
    async () => {
      const { worktree, specPath } = await makeFailingWorktree();
      const stub = new StubModelExecutor({ scripts: { build_command: [{ output: 'rework complete' }] } });
      const router = new ModelRouter(commandModels, commandRoutes, false, stub);
      const runSpy = vi.spyOn(router, 'run');
      const logs: Array<[string, string]> = [];

      await checkPhase({
        issue: workKeyFromIssue(2873),
        worktree,
        specPath,
        router,
        constitution: null,
        log: (type, msg) => logs.push([type, msg]),
        maxReworkRounds: 1,
        reworkRoute: 'command',
        reworkModel: 'my-model',
      });

      expect(runSpy.mock.calls[0][0]).toBe('build_command');
      expect(runSpy.mock.calls[0][2]?.modelOverride).toBe('my-model');
      expect(stub.calls[0]).toMatchObject({ task: 'build_command', model: 'my-model' });
      expect(logs.some(([, msg]) => msg.includes('rework route command has no runnable model'))).toBe(false);
    },
  );

  it('reroutes an unrunnable command rework route and logs why (#2873)', { timeout: 120_000 }, async () => {
    const { worktree, specPath } = await makeFailingWorktree();
    const stub = new StubModelExecutor({
      scripts: { build_codex: [{ output: 'rework complete' }], build_claude: [{ output: 'rework complete' }] },
    });
    const router = new ModelRouter(codexModels, codexRoutes, false, stub);
    const runSpy = vi.spyOn(router, 'run');
    const logs: Array<[string, string]> = [];

    await checkPhase({
      issue: workKeyFromIssue(2873),
      worktree,
      specPath,
      router,
      constitution: null,
      log: (type, msg) => logs.push([type, msg]),
      maxReworkRounds: 1,
      reworkRoute: 'command',
    });

    const override = logs.find(([type]) => type === 'model-override');
    expect(override?.[1]).toContain('rework route command has no runnable model on this machine, rerouting to');
    expect(stub.calls[0].task).toBe(`build_${runnableBuildRoutes(router)[0]}`);
    expect(runSpy.mock.calls[0][2]?.modelOverride).toBeUndefined();
  });
});

const failingSummary: CheckSummary = {
  failures: 1,
  passes: 0,
  skips: 0,
  total: 1,
  results: [{ checker: 'tests', result: 'FAIL', details: 'exit 1' }],
};

describe('reworkWorker on a declared agentic harness (#3066)', () => {
  it('runs the sandboxed declared harness command and adds a local commit (#3066)', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'check-rework-declared-'));
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

    const policy: SandboxPolicy = {
      runtime: 'sandbox-exec',
      worktree,
      writablePaths: [worktree],
      writableFilePrefixes: [],
      allowHosts: [],
      cpuMs: 300_000,
      memMb: 4096,
    };
    const calls: string[] = [];
    // Records the wrapped command but never runs it: only the commit is real.
    const stubExec = async (cmd: string, opts: { cwd?: string }) => {
      calls.push(cmd);
      const cwd = opts.cwd ?? worktree;
      await writeFile(join(cwd, 'fix.txt'), 'fix\n');
      execFileSync('git', ['add', '.'], { cwd });
      execFileSync('git', ['commit', '-q', '-m', 'fix: repair failing check'], { cwd });
      return { stdout: 'done', stderr: '' };
    };
    const logs: Array<[string, string]> = [];

    const result = await reworkWorker({
      issue: workKeyFromIssue(3066),
      worktree,
      specPath: join(worktree, 'issue-3066.md'),
      summary: failingSummary,
      constitution: null,
      router: new ModelRouter(commandModels, commandRoutes, false, new CliModelExecutor(stubExec)),
      log: (type, msg) => logs.push([type, msg]),
      sandbox: policy,
      reworkRoute: 'command',
      reworkModel: 'my-model',
    });

    expect(result.modelCompleted).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].startsWith('sandbox-exec -p ')).toBe(true);
    expect(calls[0]).toContain('my-agent');
    for (const packaged of ['claude -p', 'codex exec', 'opencode run', 'pi -p']) {
      expect(calls[0]).not.toContain(packaged);
    }
    expect(git('rev-list', '--count', 'HEAD')).toBe('2');
    expect(git('log', '-1', '--format=%s')).toBe('fix: repair failing check');
    expect(git('status', '--porcelain')).toBe('');
    expect(logs.some(([type]) => type === 'model-override')).toBe(false);
  });

  it('packaged route rework keeps the claude route and built model (#3066)', async () => {
    const { worktree, specPath } = await makeFailingWorktree();
    const stub = new StubModelExecutor({ scripts: { build_claude: [{ output: 'rework complete' }] } });
    const router = new ModelRouter(codexModels, codexRoutes, false, stub);
    const runSpy = vi.spyOn(router, 'run');
    const logs: Array<[string, string]> = [];

    await reworkWorker({
      issue: workKeyFromIssue(3066),
      worktree,
      specPath,
      summary: failingSummary,
      constitution: null,
      router,
      log: (type, msg) => logs.push([type, msg]),
      reworkRoute: 'claude',
      reworkModel: 'claude-worker',
    });

    expect(runSpy.mock.calls[0][0]).toBe('build_claude');
    expect(runSpy.mock.calls[0][2]?.modelOverride).toBe('claude-worker');
    expect(stub.calls[0]).toMatchObject({ task: 'build_claude', model: 'claude-worker' });
    expect(logs.some(([type]) => type === 'model-override')).toBe(false);
  });
});
