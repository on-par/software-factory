import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type * as FactoryCore from '@on-par/factory-core';
import type * as FactoryCoreInternal from '@on-par/factory-core/internal';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Shared mutable state the hoisted mocks read from. Set per test in beforeEach.
// ---------------------------------------------------------------------------
const h = vi.hoisted(() => {
  return {
    repoRoot: '',
    constitutionsDir: '',
    ghRepo: 'on-par/software-factory',
    // child_process shims
    execImpl: (_cmd: string): string => '',
    execSyncImpl: (_cmd: string): string => {
      throw new Error('execSync not stubbed');
    },
    claudeAvailable: undefined as boolean | undefined,
    // octokit instance returned by `new Octokit()`
    octokit: {} as any,
    // configurable core behaviour
    constitutionResolve: (_worktree: string, _product?: string): any => null,
    modelOverrides: {} as Record<string, string>,
    planResult: { ok: true, route: 'claude' } as any,
    buildResult: { ok: true } as any,
    checkResult: { passed: true, summary: { results: [], failures: 0 }, reworkRounds: 0 } as any,
    shipResult: { ok: true, prNumber: 99 } as any,
    diagnoses: [] as any[],
    costs: [] as any[],
    trailingSpend: 10,
    subscriptionUsage: null as { fiveHourUtilization: number; fiveHourResetsAt: string | null } | null,
    routerResolve: (_route: string): string | undefined => 'claude-model',
    factoryConfig: {
      merge: { auto: false, comment: '' },
      worktree: { gcTtlDays: 7, autoGcOnRun: false },
      sandbox: {
        enabled: true,
        network: { allow: ['api.anthropic.com', 'github.com'] },
        resources: { cpuMs: 300_000, memMb: 4096 },
      },
    } as any,
    gcReport: { removed: [], kept: 0, dryRun: false } as any,
    runTuiCalls: [] as Array<{
      eventsFile: string;
      repo?: string;
      stopFile?: string;
      queueFile?: string;
      queueProposedFile?: string;
      costsFile?: string;
      steeringDir?: string;
    }>,
  };
});

// ---------------------------------------------------------------------------
// Module mocks (hoisted above imports by vitest)
// ---------------------------------------------------------------------------
vi.mock('node:child_process', () => {
  const exec = (cmd: string, optsOrCb: any, maybeCb?: any) => {
    const cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb;
    try {
      const stdout = h.execImpl(cmd);
      cb(null, { stdout, stderr: '' });
    } catch (err) {
      cb(err);
    }
  };
  const execSync = (cmd: string) => h.execSyncImpl(cmd);
  return { exec, execSync, default: { exec, execSync } };
});

vi.mock('@octokit/rest', () => ({
  Octokit: vi.fn(() => h.octokit),
}));

vi.mock('@on-par/factory-tui', () => ({
  runTui: vi.fn(
    async (opts: {
      eventsFile: string;
      repo?: string;
      stopFile?: string;
      queueFile?: string;
      queueProposedFile?: string;
      costsFile?: string;
      steeringDir?: string;
    }) => {
      h.runTuiCalls.push(opts);
    },
  ),
}));

vi.mock('@on-par/factory-core', async (importOriginal) => {
  const actual = await importOriginal<typeof FactoryCore>();
  return {
    ...actual,
    // Config loaders — return inert values.
    loadModelsConfig: vi.fn(() => ({}) as any),
    loadRoutesConfig: vi.fn(() => ({}) as any),
    loadFactoryConfig: vi.fn(() => h.factoryConfig),
    resolveTimeouts: vi.fn(() => ({ plan: 1, build: 1, check: 1, approval: 1 })),
    resolveSkipCI: vi.fn(() => false),
    getConstitutionsDir: vi.fn(() => h.constitutionsDir),
    resolveEffectiveModelPins: vi.fn(() => ({
      plan: h.modelOverrides.plan,
      build: h.modelOverrides.build,
      sources: {},
    })),
    isCommandAvailable: vi.fn(() => h.claudeAvailable ?? true),
    // Router / loaders as light stubs.
    ModelRouter: vi.fn(() => ({
      resolve: (route: string) => h.routerResolve(route),
      resolveAll: (_route: string) => [],
      registryRef: {
        getClaudeFlag: () => '--flag',
        getModelsInTier: () => ['m'],
        get: () => undefined,
      },
      setCostSink: vi.fn(),
    })),
    ConstitutionLoader: vi.fn(() => ({
      listProducts: () => ['alpha', 'beta'],
      resolve: (worktree: string, product?: string) => h.constitutionResolve(worktree, product),
    })),
    ModelRegistry: vi.fn(() => ({
      list: () => ['claude-model'],
      getTiers: () => ['worker'],
      estimateCost: () => 1.23,
      isExperimental: () => false,
      isAvailable: () => true,
      getModelsInTier: () => ['claude-model'],
    })),
    // Phases.
    planPhase: vi.fn(async () => h.planResult),
    buildPhase: vi.fn(async () => h.buildResult),
    checkPhase: vi.fn(async () => h.checkResult),
    shipPhase: vi.fn(async () => h.shipResult),
    // Usage / reports.
    estimateTrailingSpend: vi.fn(() => h.trailingSpend),
    formatUsageReport: vi.fn(() => 'USAGE REPORT'),
    watchUsage: vi.fn(async () => {}),
    fetchSubscriptionUsage: vi.fn(async () => h.subscriptionUsage),
    diagnoseModels: vi.fn(() => h.diagnoses),
    writeLocalRunReport: vi.fn(async () => ({ path: '/tmp/report.md' })),
    diagnoseModelsDefault: undefined,
  };
});

vi.mock('@on-par/factory-core/internal', async (importOriginal) => {
  const actual = await importOriginal<typeof FactoryCoreInternal>();
  return {
    ...actual,
    watchChecks: vi.fn(async () => {}),
    createLocalSmallDryRun: vi.fn(async () => ({ planPath: '/tmp/plan.md', contextPath: '/tmp/ctx.md' })),
    // Cost.
    readCosts: vi.fn(() => h.costs),
    // Git / worktree side-effects — no-ops.
    setupWorktree: vi.fn(async () => {}),
    cleanupWorktree: vi.fn(async () => {}),
    gitFetch: vi.fn(async () => {}),
    withGitLock: vi.fn(async (_root: string, fn: () => Promise<unknown>) => fn()),
    withFileLock: vi.fn(async (_lock: string, fn: () => Promise<unknown>, _opts?: unknown) => fn()),
    ensureDir: vi.fn((p: string) => mkdirSync(p, { recursive: true })),
    // Worktree GC.
    sweepWorktrees: vi.fn(async () => h.gcReport),
    formatGcReport: vi.fn(
      (report: any) =>
        `GC_REPORT:${report.dryRun ? 'dry' : 'real'}:removed=${report.removed.length}:kept=${report.kept}`,
    ),
  };
});

import { cleanupWorktree, formatGcReport, sweepWorktrees, withGitLock } from '@on-par/factory-core/internal';

import { CliExitError, cmdConstitution, cmdLand, cmdUsage, main, parseIssueArg, shipIssue } from './cli/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
class ExitError extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

let exitSpy: any;
let logSpy: any;
let errSpy: any;
const savedEnv: Record<string, string | undefined> = {};

function trackEnv(...keys: string[]) {
  for (const k of keys) savedEnv[k] = process.env[k];
}

function paths() {
  const state = join(h.repoRoot, '.factory');
  return {
    state,
    queue: join(state, 'queue'),
    queueProposed: join(state, 'queue.proposed'),
    events: join(state, 'events.ndjson'),
    plans: join(state, 'plans'),
    product: join(state, 'product'),
    stop: join(state, 'STOP'),
    costs: join(state, 'costs.jsonl'),
    reports: join(state, 'reports'),
    steering: join(state, 'steering'),
    kpiHistory: join(state, 'kpi-history.jsonl'),
    breaker: join(state, 'breaker.json'),
  };
}

function defaultOctokit() {
  return {
    rest: {
      issues: { get: vi.fn(async () => ({ data: { title: 'Fix the bug' } })) },
      pulls: {
        list: vi.fn(async ({ state }: any) =>
          state === 'open'
            ? { data: [{ number: 77, head: { ref: 'ship-it/5-fix-the-bug' }, body: 'Closes #5' }] }
            : { data: [] },
        ),
        merge: vi.fn(async () => ({})),
      },
      git: { deleteRef: vi.fn(async () => ({})) },
      checks: { listForRef: vi.fn(async () => ({ data: { check_runs: [] } })) },
    },
    graphql: vi.fn(async (query: string) =>
      query.trimStart().startsWith('query')
        ? { repository: { pullRequest: { id: 'PR_ID', isDraft: false, mergeStateStatus: 'CLEAN' } } }
        : {},
    ),
  };
}

async function runMain(...args: string[]) {
  process.argv = ['node', 'factory', ...args];
  try {
    await main();
  } catch (err) {
    if (err instanceof ExitError) return { exited: true as const, code: err.code };
    throw err;
  }
  const code = process.exitCode as number | undefined;
  process.exitCode = undefined;
  return code === undefined ? { exited: false as const, code: undefined } : { exited: true as const, code };
}

beforeEach(() => {
  h.repoRoot = mkdtempSync(join(tmpdir(), 'factory-cli-'));
  h.constitutionsDir = mkdtempSync(join(tmpdir(), 'factory-const-'));
  mkdirSync(join(h.repoRoot, '.git', 'info'), { recursive: true });
  mkdirSync(paths().state, { recursive: true });
  mkdirSync(paths().plans, { recursive: true });

  h.execImpl = (cmd: string) => {
    if (cmd.includes('rev-parse')) return h.repoRoot;
    if (cmd.includes('gh repo view')) return h.ghRepo;
    return '';
  };
  h.execSyncImpl = (_cmd: string) => {
    throw new Error('no cli available');
  };
  h.octokit = defaultOctokit();
  h.constitutionResolve = () => null;
  h.modelOverrides = {};
  h.planResult = { ok: true, route: 'claude' };
  h.buildResult = { ok: true };
  h.checkResult = { passed: true, summary: { results: [], failures: 0 }, reworkRounds: 0 };
  h.shipResult = { ok: true, prNumber: 99 };
  h.diagnoses = [];
  h.costs = [];
  h.trailingSpend = 10;
  h.subscriptionUsage = null;
  h.routerResolve = () => 'claude-model';
  h.factoryConfig = {
    merge: { auto: false, comment: '' },
    worktree: { gcTtlDays: 7, autoGcOnRun: false },
    sandbox: {
      enabled: true,
      network: { allow: ['api.anthropic.com', 'github.com'] },
      resources: { cpuMs: 300_000, memMb: 4096 },
    },
  };
  h.gcReport = { removed: [], kept: 0, dryRun: false };
  h.runTuiCalls = [];
  h.claudeAvailable = undefined;

  [
    'FACTORY_LOCAL_ONLY',
    'FACTORY_MERGE',
    'FACTORY_MERGE_ADMIN',
    'FACTORY_SKIP_CI',
    'FACTORY_USAGE_CAP',
    'FACTORY_STOP_AT',
    'FACTORY_RESUME_AT',
    'FACTORY_USAGE_POLL',
    'FACTORY_USAGE_WATCH',
    'FACTORY_USAGE_ESTIMATOR',
    'FACTORY_SANDBOX',
    'GITHUB_TOKEN',
    'GH_TOKEN',
  ].forEach((k) => trackEnv(k));
  delete process.env.FACTORY_LOCAL_ONLY;
  delete process.env.FACTORY_MERGE;
  delete process.env.FACTORY_MERGE_ADMIN;
  delete process.env.FACTORY_SANDBOX;
  delete process.env.GITHUB_TOKEN;
  process.env.GH_TOKEN = 'test-token';
  process.exitCode = undefined;

  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitError(code ?? 0);
  }) as any);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  rmSync(h.repoRoot, { recursive: true, force: true });
  rmSync(h.constitutionsDir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  process.exitCode = undefined;
  exitSpy.mockRestore();
  logSpy.mockRestore();
  errSpy.mockRestore();
  vi.clearAllMocks();
});

function logged(): string {
  return logSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');
}
function errored(): string {
  return errSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');
}

// ===========================================================================
describe('cli commands (via main dispatch)', () => {
  describe('overview (bare factory)', () => {
    it('prints the designed overview and does not call process.exit', async () => {
      const res = await runMain();
      expect(res.exited).toBe(false);
      const out = logged();
      expect(out).toContain('factory — ship verified GitHub issues autonomously');
      expect(out).toContain('factory ship <issue>');
    });
  });

  describe('init', () => {
    it('creates .factory dirs, the git exclude entry, and a sample queue', async () => {
      const res = await runMain('init');
      expect(res.exited).toBe(false);
      expect(existsSync(paths().queue)).toBe(true);
      const exclude = readFileSync(join(h.repoRoot, '.git/info/exclude'), 'utf-8');
      expect(exclude).toContain('.factory/');
      expect(logged()).toContain('Initialized');
    });

    it('does not duplicate the exclude entry or clobber an existing queue', async () => {
      writeFileSync(join(h.repoRoot, '.git/info/exclude'), '.factory/\n');
      writeFileSync(paths().queue, 'app 1\n');
      await runMain('init');
      const exclude = readFileSync(join(h.repoRoot, '.git/info/exclude'), 'utf-8');
      expect(exclude.match(/\.factory\//g)).toHaveLength(1);
      expect(readFileSync(paths().queue, 'utf-8')).toBe('app 1\n');
    });

    it('exits 2 with the missing-token message when no token source is available', async () => {
      delete process.env.GITHUB_TOKEN;
      delete process.env.GH_TOKEN;
      h.execSyncImpl = (cmd: string) => {
        if (cmd.includes('gh auth token')) throw new Error('not authenticated');
        return '';
      };
      const res = await runMain('init');
      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('GITHUB_TOKEN not set — create a token at');
    });

    it('succeeds when GH_TOKEN is set even without GITHUB_TOKEN', async () => {
      delete process.env.GITHUB_TOKEN;
      process.env.GH_TOKEN = 'test-token';
      const res = await runMain('init');
      expect(res.exited).toBe(false);
      expect(logged()).toContain('Initialized');
    });
  });

  describe('constitution', () => {
    it('scaffolds a new constitution with --init', async () => {
      writeFileSync(
        join(h.constitutionsDir, '_template.md'),
        '```markdown\n---\nproduct: <product-name>\n---\n# <Product> Constitution\n```\n',
      );
      const res = await runMain('constitution', '--init', 'gizmo');
      expect(res.exited).toBe(false);
      expect(existsSync(join(h.constitutionsDir, 'gizmo.md'))).toBe(true);
      expect(logged()).toContain('Created constitution');
    });

    it('exits 1 when --init targets an existing constitution', async () => {
      writeFileSync(join(h.constitutionsDir, '_template.md'), '```markdown\n# <Product>\n```\n');
      writeFileSync(join(h.constitutionsDir, 'gizmo.md'), 'existing');
      const res = await runMain('constitution', '--init', 'gizmo');
      expect(res).toEqual({ exited: true, code: 1 });
      expect(errored()).toContain('already exists');
    });

    it('exits 2 when --init gets an invalid product name', async () => {
      const res = await runMain('constitution', '--init', '../evil');
      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('invalid product name');
    });

    it('lists products with --list', async () => {
      await runMain('constitution', '--list');
      expect(logged()).toContain('alpha');
      expect(logged()).toContain('beta');
    });

    it('sets the active product when the constitution exists', async () => {
      writeFileSync(join(h.constitutionsDir, 'alpha.md'), '# alpha');
      const res = await runMain('constitution', '--product', 'alpha');
      expect(res.exited).toBe(false);
      expect(readFileSync(paths().product, 'utf-8')).toBe('alpha');
      expect(logged()).toContain('Active product: alpha');
    });

    it('exits 1 for --product on a missing constitution', async () => {
      const res = await runMain('constitution', '--product', 'nope');
      expect(res).toEqual({ exited: true, code: 1 });
      expect(errored()).toContain("No constitution 'nope'");
    });

    it('exits 2 with a usage line when no sub-option is given', async () => {
      const res = await runMain('constitution');
      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('usage: factory constitution');
    });

    it('rethrows an unexpected scaffolding error uncaught (not a CliExitError)', async () => {
      writeFileSync(join(h.constitutionsDir, '_template.md'), 'no markdown skeleton block here');
      await expect(runMain('constitution', '--init', 'gizmo')).rejects.toThrow(
        'constitution template is missing its ```markdown skeleton block',
      );
    });
  });

  describe('models', () => {
    it('lists models, costs, and tiers', async () => {
      await runMain('models');
      const out = logged();
      expect(out).toContain('Available Models');
      expect(out).toContain('claude-model');
      expect(out).toContain('Tiers');
      expect(out).toContain('boss:');
    });

    it('doctor prints the report and returns when a worker is reachable', async () => {
      h.diagnoses = [
        { model: 'w', provider: 'openai', tiers: ['worker'], reachable: true, experimental: false, reason: 'ok' },
      ];
      const res = await runMain('models', '--doctor');
      expect(res.exited).toBe(false);
      expect(logged()).toContain('Model Doctor');
    });

    it('doctor exits 1 when no worker is reachable', async () => {
      h.diagnoses = [
        { model: 'b', provider: 'anthropic', tiers: ['boss'], reachable: true, experimental: false, reason: 'ok' },
      ];
      const res = await runMain('models', '--doctor');
      expect(res).toEqual({ exited: true, code: 1 });
      expect(errored()).toContain('no worker model is reachable');
    });
  });

  describe('cost', () => {
    it('reports no data when there are no costs', async () => {
      h.costs = [];
      await runMain('cost');
      expect(logged()).toContain('no cost data yet');
    });

    it('aggregates costs by model with a grand total', async () => {
      h.costs = [
        { model: 'a', cost: 1 },
        { model: 'a', cost: 0.5 },
        { model: 'b', cost: 2 },
      ];
      await runMain('cost');
      const out = logged();
      expect(out).toContain('Cost Summary');
      expect(out).toContain('a: 2 tasks, $1.5000');
      expect(out).toContain('b: 1 tasks, $2.0000');
      expect(out).toContain('Total: $3.5000');
    });

    it('shows a per-entry breakdown filtered to one issue via --issue', async () => {
      h.costs = [
        { issue: '296', task: 'build_codex', model: 'qwen', cost: 0, failoverReason: 'rate_limit' },
        { issue: '296', task: 'plan', model: 'opus', cost: 0.12 },
        { issue: '7', task: 'plan', model: 'opus', cost: 0.05 },
      ];
      await runMain('cost', '--issue', '296');
      const out = logged();
      expect(out).toContain('build_codex');
      expect(out).toContain('qwen');
      expect(out).toContain('[failover: rate_limit]');
      expect(out).not.toContain('0.05');
    });

    it('reports no cost data for an issue with no entries', async () => {
      h.costs = [{ issue: '7', task: 'plan', model: 'opus', cost: 0.05 }];
      await runMain('cost', '--issue', '296');
      expect(logged()).toContain('no cost data for issue 296');
    });

    it('appends a failover count to the summary line only when failovers are present', async () => {
      h.costs = [
        { model: 'a', cost: 1 },
        { model: 'a', cost: 0.5, failoverReason: 'rate_limit' },
        { model: 'b', cost: 2 },
      ];
      await runMain('cost');
      const out = logged();
      expect(out).toContain('a: 2 tasks, $1.5000 (1 failover)');
      expect(out).toContain('b: 1 tasks, $2.0000');
      expect(out).not.toContain('b: 1 tasks, $2.0000 (');
    });
  });

  describe('usage', () => {
    it('prints the usage report from resolved knobs', async () => {
      await runMain('usage');
      expect(logged()).toContain('USAGE REPORT');
    });

    it('exits 2 on an invalid usage cap', async () => {
      process.env.FACTORY_USAGE_CAP = '-5';
      const res = await runMain('usage');
      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('FACTORY_USAGE_CAP');
    });
  });

  describe('status', () => {
    it('prints product, models, queue, events, and STOP state', async () => {
      writeFileSync(paths().product, 'alpha\n');
      writeFileSync(paths().queue, '# comment\napp 1\napp 2\n');
      writeFileSync(
        paths().events,
        [
          JSON.stringify({ type: 'ready', issue: 1, msg: 'done' }),
          'not-json',
          JSON.stringify({ type: 'issue-title', issue: '2', msg: 'title' }),
          JSON.stringify({ type: 'merged', issue: '2', msg: 'merged' }),
          JSON.stringify({ type: 'issue-title', issue: '3', msg: 'title' }),
          JSON.stringify({ type: 'rework', issue: '3', msg: 'rework' }),
          JSON.stringify({ type: 'issue-title', issue: '4', msg: 'title' }),
          JSON.stringify({ type: 'parked', issue: '4', msg: 'parked' }),
          '',
        ].join('\n'),
      );
      writeFileSync(paths().stop, '');
      await runMain('status');
      const out = logged();
      expect(out).toContain('on-par/software-factory');
      expect(out).toContain('Product: alpha');
      expect(out).toContain('app 1');
      expect(out).toContain('ready #1: done');
      expect(out).toContain('== Health KPIs ==');
      expect(out).toContain('Merge rate:');
      expect(logged() + errored()).toContain('STOP file present');
    });

    it('handles an empty queue and no events gracefully', async () => {
      writeFileSync(paths().queue, '# only comments\n');
      await runMain('status');
      const out = logged();
      expect(out).toContain('(empty)');
      expect(out).toContain('(none)');
      expect(out).toContain('Product: (none)');
      expect(out).toContain('No factory runs recorded yet.');
    });

    it('warns on malformed queue lines and never renders NaN', async () => {
      writeFileSync(paths().queue, 'app 1\napp abc\n');
      await runMain('status');
      expect(logged()).toContain('app 1');
      const err = errored();
      expect(err).toContain('malformed');
      expect(err).toContain('line 2');
      expect(logged() + err).not.toContain('NaN');
    });

    it('prints "(no queue file)" when the queue does not exist', async () => {
      const res = await runMain('status');
      expect(res.exited).toBe(false);
      expect(logged()).toContain('(no queue file)');
    });

    it('shows an open provider breaker without mutating the breaker file', async () => {
      const breakerFixture = {
        version: 1,
        providers: {
          openai: { reason: 'usage_cap', openedAt: new Date().toISOString(), cooldownMs: 1_800_000 },
        },
      };
      writeFileSync(paths().breaker, JSON.stringify(breakerFixture));

      await runMain('status');
      const out = logged();
      expect(out).toContain('== Provider breaker ==');
      expect(out).toContain('openai: OPEN (usage_cap)');
      expect(out).toContain('m remaining');
      expect(existsSync(paths().breaker)).toBe(true);
    });

    it('shows "(closed)" when there is no breaker file', async () => {
      await runMain('status');
      const out = logged();
      expect(out).toContain('== Provider breaker ==');
      expect(out).toContain('(closed)');
    });
  });

  describe('kpis', () => {
    it('renders a report and trend, and records a snapshot on each run', async () => {
      writeFileSync(
        paths().events,
        [
          JSON.stringify({ type: 'issue-title', issue: '1', msg: 'title' }),
          JSON.stringify({ type: 'merged', issue: '1', msg: 'merged' }),
          JSON.stringify({ type: 'issue-title', issue: '2', msg: 'title' }),
          JSON.stringify({ type: 'rework', issue: '2', msg: 'rework' }),
          '',
        ].join('\n'),
      );
      writeFileSync(paths().costs, '');
      h.costs = [{ issue: '1', task: 'build', model: 'a', cost: 0.5 }];

      await runMain('kpis');
      const out = logged();
      expect(out).toContain('## Health KPIs');
      expect(out).toContain('## Health KPI trend');
      expect(existsSync(paths().kpiHistory)).toBe(true);
      const historyLines = (jsonl: string) => jsonl.trim().split('\n').filter(Boolean);
      expect(historyLines(readFileSync(paths().kpiHistory, 'utf-8'))).toHaveLength(1);

      await runMain('kpis');
      expect(historyLines(readFileSync(paths().kpiHistory, 'utf-8'))).toHaveLength(2);
    });
  });

  describe('tui', () => {
    it('calls runTui with the events file and detected repo', async () => {
      const res = await runMain('tui');
      expect(res.exited).toBe(false);
      expect(h.runTuiCalls).toHaveLength(1);
      expect(h.runTuiCalls[0].eventsFile.endsWith(join('.factory', 'events.ndjson'))).toBe(true);
      expect(h.runTuiCalls[0].repo).toBe(h.ghRepo);
      expect(h.runTuiCalls[0].stopFile?.endsWith(join('.factory', 'STOP'))).toBe(true);
      expect(h.runTuiCalls[0].queueFile?.endsWith(join('.factory', 'queue'))).toBe(true);
      expect(h.runTuiCalls[0].queueProposedFile?.endsWith(join('.factory', 'queue.proposed'))).toBe(true);
      expect(h.runTuiCalls[0].costsFile?.endsWith(join('.factory', 'costs.jsonl'))).toBe(true);
      expect(h.runTuiCalls[0].steeringDir?.endsWith(join('.factory', 'steering'))).toBe(true);
    });

    it('calls runTui with repo undefined when gh repo detection fails', async () => {
      h.execImpl = (cmd: string) => {
        if (cmd.includes('rev-parse')) return h.repoRoot;
        if (cmd.includes('gh repo view')) throw new Error('gh not authenticated');
        return '';
      };
      const res = await runMain('tui');
      expect(res.exited).toBe(false);
      expect(h.runTuiCalls).toHaveLength(1);
      expect(h.runTuiCalls[0].repo).toBeUndefined();
    });
  });

  describe('triage', () => {
    it('prints the proposed queue with an accept hint', async () => {
      h.execImpl = (cmd: string) => {
        if (cmd.includes('rev-parse')) return h.repoRoot;
        if (cmd.includes('gh repo view')) return h.ghRepo;
        if (cmd.includes('claude -p')) {
          writeFileSync(paths().queueProposed, 'app 5\napp 6\n');
          return '';
        }
        return '';
      };
      await runMain('triage');
      const out = logged();
      expect(out).toContain('app 5');
      expect(out).toContain('factory triage accept');
    });

    it('exits 1 when triage produces no proposal', async () => {
      const res = await runMain('triage');
      expect(res).toEqual({ exited: true, code: 1 });
      expect(errored()).toContain('no proposal');
    });

    it('exits 2 with the not-initialized message when .factory/ is missing', async () => {
      rmSync(paths().state, { recursive: true, force: true });
      const res = await runMain('triage');
      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('factory not initialized — run `factory init` first');
    });

    it('logs the planner failure detail and exits 1 with no proposal when the planner exec call fails', async () => {
      h.execImpl = (cmd: string) => {
        if (cmd.includes('rev-parse')) return h.repoRoot;
        if (cmd.includes('gh repo view')) return h.ghRepo;
        if (cmd.includes('claude -p')) throw new Error('claude crashed');
        return '';
      };
      const res = await runMain('triage');
      expect(res).toEqual({ exited: true, code: 1 });
      expect(errored()).toContain('no proposal');
      expect(errored()).toContain('claude crashed');
      const events = readFileSync(paths().events, 'utf-8');
      expect(events).toContain('triage planner failed');
    });
  });

  describe('triage accept', () => {
    beforeEach(() => {
      h.execImpl = (cmd: string) => (cmd.includes('rev-parse') ? h.repoRoot : '');
    });

    it('accepts a valid proposed queue', async () => {
      writeFileSync(paths().queueProposed, 'app 5\napp 6\n');
      await runMain('triage', 'accept');
      expect(existsSync(paths().queueProposed)).toBe(false);
      expect(readFileSync(paths().queue, 'utf-8')).toBe('app 5\napp 6\n');
      expect(logged()).toContain('queue accepted');
      const events = readFileSync(paths().events, 'utf-8');
      expect(events).toContain('"type":"triage_accepted"');
      expect(events).toContain('5, 6');
    });

    it('rejects an invalid queue and leaves it unchanged', async () => {
      writeFileSync(paths().queueProposed, 'app 5\napp notanumber\n');
      const res = await runMain('triage', 'accept');
      expect(res).toEqual({ exited: true, code: 1 });
      const err = errored();
      expect(err).toContain('invalid');
      expect(err).toContain('malformed');
      expect(existsSync(paths().queueProposed)).toBe(true);
      expect(readFileSync(paths().queueProposed, 'utf-8')).toBe('app 5\napp notanumber\n');
      expect(existsSync(paths().queue)).toBe(false);
    });

    it('reports nothing to accept when there is no proposed queue', async () => {
      const res = await runMain('triage', 'accept');
      expect(res.exited).toBe(false);
      expect(logged()).toContain('nothing to accept');
    });

    it('--force skips validation and promotes as-is', async () => {
      writeFileSync(paths().queueProposed, 'app notanumber\n');
      await runMain('triage', 'accept', '--force');
      expect(existsSync(paths().queueProposed)).toBe(false);
      expect(readFileSync(paths().queue, 'utf-8')).toBe('app notanumber\n');
      const events = readFileSync(paths().events, 'utf-8');
      expect(events).toContain('triage_accepted');
      expect(events).toContain('--force');
    });
  });

  describe('stop / resume', () => {
    it('stop writes the STOP file', async () => {
      await runMain('stop');
      expect(existsSync(paths().stop)).toBe(true);
      expect(logged()).toContain('STOP set');
    });

    it('resume removes an existing STOP file', async () => {
      writeFileSync(paths().stop, '');
      await runMain('resume');
      expect(existsSync(paths().stop)).toBe(false);
      expect(logged()).toContain('STOP cleared');
    });

    it('resume is a no-op when there is no STOP file', async () => {
      await runMain('resume');
      expect(logged()).toContain('STOP cleared');
    });
  });

  describe('run', () => {
    it('exits 2 when the queue file is missing', async () => {
      rmSync(paths().queue, { force: true });
      const res = await runMain('run');
      expect(res).toEqual({ exited: true, code: 2 });
    });

    it('reads the queue, starts lanes, and stops immediately when STOP is present', async () => {
      writeFileSync(paths().queue, '# header\napp 1\napp 2\ndocs 3\n');
      writeFileSync(paths().stop, '');
      const res = await runMain('run');
      expect(res.exited).toBe(false);
      const events = readFileSync(paths().events, 'utf-8');
      expect(events).toContain('stopped');
      expect(events).toContain('run-done');
    });

    it('runs worktree gc before lanes when worktree.autoGcOnRun is true', async () => {
      h.factoryConfig = { merge: { auto: false, comment: '' }, worktree: { gcTtlDays: 7, autoGcOnRun: true } };
      writeFileSync(paths().queue, '# header\napp 1\n');
      writeFileSync(paths().stop, '');
      const res = await runMain('run');
      expect(res.exited).toBe(false);
      expect(sweepWorktrees).toHaveBeenCalledWith(
        expect.objectContaining({ repoRoot: h.repoRoot, ttlDays: 7 }),
        expect.anything(),
      );
      expect(formatGcReport).toHaveBeenCalled();
    });

    it('does not run worktree gc when worktree.autoGcOnRun is false', async () => {
      h.factoryConfig = { merge: { auto: false, comment: '' }, worktree: { gcTtlDays: 7, autoGcOnRun: false } };
      writeFileSync(paths().queue, '# header\napp 1\n');
      writeFileSync(paths().stop, '');
      const res = await runMain('run');
      expect(res.exited).toBe(false);
      expect(sweepWorktrees).not.toHaveBeenCalled();
    });

    it('proceeds with the run even when worktree gc rejects', async () => {
      h.factoryConfig = { merge: { auto: false, comment: '' }, worktree: { gcTtlDays: 7, autoGcOnRun: true } };
      (sweepWorktrees as any).mockRejectedValueOnce(new Error('gc boom'));
      writeFileSync(paths().queue, '# header\napp 1\n');
      writeFileSync(paths().stop, '');
      const res = await runMain('run');
      expect(res.exited).toBe(false);
      const events = readFileSync(paths().events, 'utf-8');
      expect(events).toContain('gc boom');
      expect(events).toContain('run-done');
    });

    it('skips malformed queue lines, starts lanes only for valid entries, and warns', async () => {
      writeFileSync(paths().queue, '# header\napp 1\napp abc\ndocs 3\n');
      writeFileSync(paths().stop, '');
      const res = await runMain('run');
      expect(res.exited).toBe(false);
      const err = errored();
      expect(err).toContain('malformed');
      const events = readFileSync(paths().events, 'utf-8');
      expect(events).toContain(`lane 'app' started (1 issues)`);
      expect(events).toContain(`lane 'docs' started (1 issues)`);
      expect(events).toContain('run-done');
      expect(events + err).not.toContain('NaN');
    });

    it('skips starting the usage watchdog when FACTORY_USAGE_WATCH=0', async () => {
      trackEnv('FACTORY_USAGE_WATCH');
      process.env.FACTORY_USAGE_WATCH = '0';
      writeFileSync(paths().queue, 'app 1\n');
      writeFileSync(paths().stop, '');
      const res = await runMain('run');
      expect(res.exited).toBe(false);
      const events = readFileSync(paths().events, 'utf-8');
      expect(events).toContain('run-done');
    });

    it('logs a warn event without crashing the run when the usage watchdog rejects', async () => {
      const core = await import('@on-par/factory-core');
      vi.mocked(core.watchUsage).mockRejectedValueOnce(new Error('watchdog exploded'));
      writeFileSync(paths().queue, 'app 1\n');
      writeFileSync(paths().stop, '');
      const res = await runMain('run');
      expect(res.exited).toBe(false);
      const events = readFileSync(paths().events, 'utf-8');
      expect(events).toContain('usage watchdog crashed');
      expect(events).toContain('watchdog exploded');
    });
  });

  describe('worktree gc', () => {
    it('dry-run calls sweepWorktrees with dryRun: true and takes no lock', async () => {
      h.gcReport = { removed: [], kept: 3, dryRun: true };
      const res = await runMain('worktree', 'gc', '--dry-run');
      expect(res.exited).toBe(false);
      expect(sweepWorktrees).toHaveBeenCalledWith(
        expect.objectContaining({ repoRoot: h.repoRoot, ttlDays: 7, dryRun: true }),
        expect.anything(),
      );
      expect(withGitLock).not.toHaveBeenCalled();
      expect(logged()).toContain('GC_REPORT:dry:removed=0:kept=3');
    });

    it('--ttl-days overrides the config default', async () => {
      const res = await runMain('worktree', 'gc', '--ttl-days', '3');
      expect(res.exited).toBe(false);
      expect(sweepWorktrees).toHaveBeenCalledWith(expect.objectContaining({ ttlDays: 3 }), expect.anything());
    });

    it('exits 2 on a non-numeric --ttl-days', async () => {
      const res = await runMain('worktree', 'gc', '--ttl-days', 'nope');
      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('--ttl-days');
    });
  });

  describe('supervise', () => {
    it('exits 2 when the queue is empty', async () => {
      writeFileSync(paths().queue, '# just comments\n');
      const res = await runMain('supervise', '--now');
      expect(res).toEqual({ exited: true, code: 2 });
    });

    it('exits 2 on invalid usage knobs', async () => {
      writeFileSync(paths().queue, 'app 1\n');
      process.env.FACTORY_USAGE_CAP = 'abc';
      const res = await runMain('supervise', '--now');
      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('FACTORY_USAGE_CAP');
    });

    it('exits 2 when the queue contains only malformed lines, and warns why', async () => {
      writeFileSync(paths().queue, 'app abc\n');
      const res = await runMain('supervise', '--now');
      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('malformed');
    });

    it('--now runs the queue once end-to-end and finishes once the queue drains without STOP', async () => {
      process.env.FACTORY_MERGE = '1';
      writeFileSync(paths().queue, 'app 1\n');
      const res = await runMain('supervise', '--now');
      expect(res.exited).toBe(false);
      const events = readFileSync(paths().events, 'utf-8');
      expect(events).toContain('supervisor-done');
      expect(events).toContain('run-done');
    }, 20_000);
  });

  describe('local-small-dry-run', () => {
    it('creates the dry-run plan and context and prints their paths', async () => {
      const res = await runMain('local-small-dry-run', '5');
      expect(res.exited).toBe(false);
      const out = logged();
      expect(out).toContain('/tmp/plan.md');
      expect(out).toContain('/tmp/ctx.md');
    });
  });

  describe('local-small-overnight', () => {
    it('exits 2 mentioning the expected path when the queue file is missing', async () => {
      const res = await runMain('local-small-overnight');
      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain(join(paths().state, 'local-small', 'overnight-queue'));
    });

    it('exits 2 when the queue file has only malformed lines', async () => {
      const queueDir = join(paths().state, 'local-small');
      mkdirSync(queueDir, { recursive: true });
      writeFileSync(join(queueDir, 'overnight-queue'), 'not a valid line\n');
      const res = await runMain('local-small-overnight');
      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('malformed');
    });

    it('runs the happy path: ships the queued issue and records it as ready', async () => {
      h.diagnoses = [
        { model: 'w', provider: 'openai', tiers: ['worker'], reachable: true, experimental: false, reason: 'ok' },
      ];
      const queueDir = join(paths().state, 'local-small');
      mkdirSync(queueDir, { recursive: true });
      writeFileSync(join(queueDir, 'overnight-queue'), 'overnight 5\n');

      const res = await runMain('local-small-overnight');

      expect(res.exited).toBe(false);
      expect(logged()).toContain('overnight ready: 1');

      const state = JSON.parse(readFileSync(join(queueDir, 'overnight-state.json'), 'utf-8'));
      expect(state.items).toEqual([expect.objectContaining({ issue: 5, status: 'ready' })]);
    });

    it('exits 4 mentioning halted when preflight fails', async () => {
      h.claudeAvailable = false;
      const queueDir = join(paths().state, 'local-small');
      mkdirSync(queueDir, { recursive: true });
      writeFileSync(join(queueDir, 'overnight-queue'), 'overnight 5\n');

      const res = await runMain('local-small-overnight');

      expect(res).toEqual({ exited: true, code: 4 });
      expect(errored()).toContain('halted');
    });

    it('exits 4 mentioning no reachable local worker when no worker-tier model is reachable', async () => {
      h.diagnoses = [
        { model: 'w', provider: 'openai', tiers: ['worker'], reachable: false, experimental: false, reason: 'no key' },
      ];
      const queueDir = join(paths().state, 'local-small');
      mkdirSync(queueDir, { recursive: true });
      writeFileSync(join(queueDir, 'overnight-queue'), 'overnight 5\n');

      const res = await runMain('local-small-overnight');

      expect(res).toEqual({ exited: true, code: 4 });
      expect(errored()).toContain('no reachable local worker model');
    });

    it('parks an item, reports it, and logs overnight-park when shipIssue escalates', async () => {
      h.diagnoses = [
        { model: 'w', provider: 'openai', tiers: ['worker'], reachable: true, experimental: false, reason: 'ok' },
      ];
      h.planResult = { ok: false, route: 'claude', escalate: 'needs human' };
      const queueDir = join(paths().state, 'local-small');
      mkdirSync(queueDir, { recursive: true });
      writeFileSync(join(queueDir, 'overnight-queue'), 'overnight 5\n');

      const res = await runMain('local-small-overnight');

      expect(res.exited).toBe(false);
      expect(logged()).toContain('overnight parked: 1');
      expect(logged()).toContain('parked');
      const events = readFileSync(paths().events, 'utf-8');
      expect(events).toContain('overnight-park');

      const state = JSON.parse(readFileSync(join(queueDir, 'overnight-state.json'), 'utf-8'));
      expect(state.items).toEqual([expect.objectContaining({ issue: 5, status: 'parked' })]);
    });
  });

  describe('land', () => {
    it('lands an open PR and prints success', async () => {
      const res = await runMain('land', '5');
      expect(res.exited).toBe(false);
      expect(logged()).toContain('Landed PR #77');
      expect(h.octokit.rest.pulls.merge).toHaveBeenCalled();
    });

    it('exits 1 when there is no open PR for the issue', async () => {
      h.octokit.rest.pulls.list = vi.fn(async () => ({ data: [] }));
      const res = await runMain('land', '5');
      expect(res).toEqual({ exited: true, code: 1 });
      expect(errored()).toContain('no open PR');
    });

    it('exits 3 on a rebase conflict (LandConflictError)', async () => {
      h.octokit.graphql = vi.fn(async (query: string) =>
        query.trimStart().startsWith('query')
          ? { repository: { pullRequest: { id: 'PR_ID', isDraft: false, mergeStateStatus: 'DIRTY' } } }
          : {},
      );
      // worktree does not exist -> DIRTY with missing worktree -> LandConflictError
      const res = await runMain('land', '5');
      expect(res).toEqual({ exited: true, code: 3 });
      expect(errored()).toContain('factory:');
    });

    it('wraps a PR-lookup failure as a code-5 CliExitError naming the issue and branch', async () => {
      h.octokit.rest.pulls.list = vi.fn(async ({ state }: any) => {
        if (state === 'open') throw new Error('rate limited');
        return { data: [] };
      });
      const res = await runMain('land', '5');
      expect(res).toEqual({ exited: true, code: 5 });
      expect(errored()).toContain('PR lookup failed for issue #5');
      expect(errored()).toContain('rate limited');
    });

    it('wraps a post-merge cleanup failure as a code-5 CliExitError', async () => {
      vi.mocked(cleanupWorktree).mockRejectedValueOnce(new Error('rm -rf failed'));
      const res = await runMain('land', '5');
      expect(res).toEqual({ exited: true, code: 5 });
      expect(errored()).toContain('merge failed for issue #5');
      expect(errored()).toContain('rm -rf failed');
    });

    it('wraps an unexpected pre-lock failure (e.g. issue lookup) in a generic code-5 CliExitError', async () => {
      h.octokit.rest.issues.get = vi.fn(async () => {
        throw new Error('issue vanished');
      });
      const res = await runMain('land', '5');
      expect(res).toEqual({ exited: true, code: 5 });
      expect(errored()).toContain('merge failed for issue #5');
      expect(errored()).toContain('issue vanished');
    });
  });

  describe('resume-approved', () => {
    it('resolves cleanly when there are no open factory PRs', async () => {
      const res = await runMain('resume-approved');
      expect(res.exited).toBe(false);
      expect(errored()).toBe('');
    });

    it('exits 5 and reports failed PRs when landing an approved PR fails', async () => {
      h.octokit.graphql = vi.fn(async (query: string) => {
        if (query.includes('OpenFactoryPRs')) {
          return {
            repository: {
              pullRequests: {
                pageInfo: { hasNextPage: false },
                nodes: [
                  { number: 12, headRefName: 'ship-it/5-fix-the-bug', reviewDecision: 'APPROVED', isDraft: false },
                ],
              },
            },
          };
        }
        return {};
      });
      h.octokit.rest.issues.get = vi.fn(async () => {
        throw new Error('issue vanished');
      });
      const res = await runMain('resume-approved');
      expect(res).toEqual({ exited: true, code: 5 });
      expect(logged()).toContain('failed to land');
      expect(errored()).toContain('1 PR(s) failed to land');
    });
  });

  describe('ship (via cmdShip)', () => {
    it('ships an issue through all phases and prints the ready PR', async () => {
      const res = await runMain('ship', '5');
      expect(res.exited).toBe(false);
      expect(logged()).toContain('PR #99 ready for review');
    });

    it('prints a yellow SKIP line for a skipped checker while the run still succeeds', async () => {
      h.checkResult = {
        passed: true,
        summary: {
          results: [
            {
              checker: 'tests',
              result: 'SKIP',
              details: 'no verification command was run — no scripts/verify.sh and no package.json test script found',
            },
          ],
          failures: 0,
        },
        reworkRounds: 0,
      };
      const res = await runMain('ship', '5');
      expect(res.exited).toBe(false);
      expect(errored()).toContain('SKIP: tests');
    });

    it('exits 1 and logs a park event when a check fails', async () => {
      h.checkResult = {
        passed: false,
        summary: { results: [{ checker: 'lint', result: 'FAIL', details: 'bad' }], failures: 1 },
        reworkRounds: 2,
      };
      const res = await runMain('ship', '5');
      expect(res).toEqual({ exited: true, code: 1 });
      const events = readFileSync(paths().events, 'utf-8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      const failEvents = events.filter((e: any) => e.type === 'fail' && e.issue === '5');
      expect(failEvents).toHaveLength(1);
      expect(errored()).toContain('Ship failed');
    });

    it('exits 1 and logs exactly one park event when a check fails under FACTORY_LOCAL_ONLY=1', async () => {
      trackEnv('FACTORY_LOCAL_ONLY');
      process.env.FACTORY_LOCAL_ONLY = '1';
      h.checkResult = {
        passed: false,
        summary: { results: [{ checker: 'lint', result: 'FAIL', details: 'bad' }], failures: 1 },
        reworkRounds: 2,
      };
      const res = await runMain('ship', '5');
      expect(res).toEqual({ exited: true, code: 1 });
      const events = readFileSync(paths().events, 'utf-8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      const failEvents = events.filter((e: any) => e.type === 'fail' && e.issue === '5');
      expect(failEvents).toHaveLength(1);
      expect(errored()).toContain('Ship failed');
    });

    it('reaches shipPhase without an approval gate when --interactive is not passed', async () => {
      const core = await import('@on-par/factory-core');
      const res = await runMain('ship', '5');
      expect(res.exited).toBe(false);
      const call = vi.mocked(core.shipPhase).mock.calls.at(-1)?.[0] as any;
      expect(call.approvalGate).toBeUndefined();
    });

    it('passes an approval gate to shipPhase when --interactive is set', async () => {
      const core = await import('@on-par/factory-core');
      const res = await runMain('ship', '5', '--interactive');
      expect(res.exited).toBe(false);
      const call = vi.mocked(core.shipPhase).mock.calls.at(-1)?.[0] as any;
      expect(typeof call.approvalGate).toBe('function');
    });

    it('reaches planPhase without an approval gate when --approve-plan is not passed', async () => {
      const core = await import('@on-par/factory-core');
      const res = await runMain('ship', '5');
      expect(res.exited).toBe(false);
      const call = vi.mocked(core.planPhase).mock.calls.at(-1)?.[0] as any;
      expect(call.approvalGate).toBeUndefined();
      expect(call.drainSteering).toBeUndefined();
    });

    it('passes an approval gate and drainSteering to planPhase when --approve-plan is set', async () => {
      const core = await import('@on-par/factory-core');
      const res = await runMain('ship', '5', '--approve-plan');
      expect(res.exited).toBe(false);
      const call = vi.mocked(core.planPhase).mock.calls.at(-1)?.[0] as any;
      expect(typeof call.approvalGate).toBe('function');
      expect(typeof call.drainSteering).toBe('function');
    });

    it('exits 2 with the missing-claude message and never invokes the phase mocks when claude is unavailable', async () => {
      h.claudeAvailable = false;
      const core = await import('@on-par/factory-core');
      const res = await runMain('ship', '42');
      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('claude CLI not found — install Claude Code first:');
      expect(vi.mocked(core.planPhase)).not.toHaveBeenCalled();
      expect(vi.mocked(core.buildPhase)).not.toHaveBeenCalled();
      expect(vi.mocked(core.checkPhase)).not.toHaveBeenCalled();
      expect(vi.mocked(core.shipPhase)).not.toHaveBeenCalled();
    });

    it('exits 2 with the not-initialized message when .factory/ is missing', async () => {
      rmSync(paths().state, { recursive: true, force: true });
      const res = await runMain('ship', '5');
      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('factory not initialized — run `factory init` first');
    });

    it('parses --no-sandbox to opts.sandbox === false and logs sandbox disabled by the CLI flag', async () => {
      const res = await runMain('ship', '5', '--no-sandbox');
      expect(res.exited).toBe(false);
      expect(errored()).toContain('sandbox disabled by --no-sandbox — agent runs are UNCONTAINED');
      const events = readFileSync(paths().events, 'utf-8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(events.some((e: any) => e.type === 'sandbox-disabled' && e.msg.includes('--no-sandbox'))).toBe(true);
    });

    it('defaults --sandbox to true (no CLI-disabled event) when the flag is not passed', async () => {
      const res = await runMain('ship', '5');
      expect(res.exited).toBe(false);
      expect(errored()).not.toContain('sandbox disabled by --no-sandbox');
      const events = readFileSync(paths().events, 'utf-8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(events.some((e: any) => e.type === 'sandbox-disabled' && e.msg.includes('--no-sandbox'))).toBe(false);
    });
  });

  describe('doctor', () => {
    beforeEach(() => {
      h.execSyncImpl = (cmd: string) => {
        if (cmd.includes('rev-parse')) return h.repoRoot;
        if (cmd.includes('status --porcelain')) return '';
        if (cmd.includes('gh auth token')) return 'gho_token';
        if (cmd.includes('gh auth status')) return 'Logged in';
        return '';
      };
    });

    it('prints the report and does not exit when the environment is all green', async () => {
      h.claudeAvailable = true;
      const res = await runMain('doctor');
      expect(res.exited).toBe(false);
      expect(logged()).toContain('== factory doctor ==');
    });

    it('exits 1 when claude is unavailable', async () => {
      h.claudeAvailable = false;
      const res = await runMain('doctor');
      expect(res).toEqual({ exited: true, code: 1 });
    });

    it('exits 1 and reports auth failure when an execSync probe throws', async () => {
      h.claudeAvailable = true;
      h.execSyncImpl = (cmd: string) => {
        if (cmd.includes('rev-parse')) return h.repoRoot;
        if (cmd.includes('status --porcelain')) return '';
        if (cmd.includes('gh auth token')) return 'gho_token';
        if (cmd.includes('gh auth status')) throw new Error('not logged in');
        return '';
      };
      const res = await runMain('doctor');
      expect(res).toEqual({ exited: true, code: 1 });
      expect(logged()).toContain('gh is not authenticated');
    });

    it('reports a live and a stale port lease without failing doctor', async () => {
      h.claudeAvailable = true;
      const portsFile = join(h.repoRoot, '.factory', 'ports.json');
      writeFileSync(
        portsFile,
        JSON.stringify({
          version: 1,
          leases: [
            {
              worktreeId: h.repoRoot,
              branch: 'live',
              port: 4001,
              pid: process.pid,
              acquiredAt: '2026-01-01T00:00:00Z',
            },
            {
              worktreeId: '/nonexistent/wt',
              branch: 'gone',
              port: 4002,
              pid: 2 ** 30,
              acquiredAt: '2026-01-01T00:00:00Z',
            },
          ],
        }),
      );

      const res = await runMain('doctor');
      expect(res.exited).toBe(false);
      expect(logged()).toContain('port lease :4001');
      expect(logged()).toContain('port lease :4002');
      expect(logged()).toContain('--reconcile');
    });

    it('--reconcile removes stale leases and reports freed ports', async () => {
      h.claudeAvailable = true;
      const portsFile = join(h.repoRoot, '.factory', 'ports.json');
      writeFileSync(
        portsFile,
        JSON.stringify({
          version: 1,
          leases: [
            {
              worktreeId: h.repoRoot,
              branch: 'live',
              port: 4001,
              pid: process.pid,
              acquiredAt: '2026-01-01T00:00:00Z',
            },
            {
              worktreeId: '/nonexistent/wt',
              branch: 'gone',
              port: 4002,
              pid: 2 ** 30,
              acquiredAt: '2026-01-01T00:00:00Z',
            },
          ],
        }),
      );

      const res = await runMain('doctor', '--reconcile');
      expect(res.exited).toBe(false);
      expect(logged()).toContain('reconcile: freed port 4002');

      const registry = JSON.parse(readFileSync(portsFile, 'utf-8'));
      expect(registry.leases).toHaveLength(1);
      expect(registry.leases[0].port).toBe(4001);
    });

    it('reports event log corruption count and percentage', async () => {
      h.claudeAvailable = true;
      writeFileSync(
        paths().events,
        ['{"ts":"1"}', '{"ts":"2"}', '{"ts":"3"}', '{"ts":"4"}', 'not json'].join('\n') + '\n',
      );

      const res = await runMain('doctor');
      expect(res.exited).toBe(false);
      expect(logged()).toContain('unparseable');
      expect(logged()).toContain('(20.0%)');
    });
  });

  describe('git/github detection failures', () => {
    it('exits 2 with "not inside a git repository" when git rev-parse fails', async () => {
      h.execImpl = (cmd: string) => {
        if (cmd.includes('rev-parse')) throw new Error('fatal: not a git repository');
        return '';
      };
      const res = await runMain('status');
      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('not inside a git repository');
    });

    it('falls back to `gh auth token` via execSync when no GITHUB_TOKEN/GH_TOKEN env var is set', async () => {
      delete process.env.GITHUB_TOKEN;
      delete process.env.GH_TOKEN;
      h.execSyncImpl = (cmd: string) => {
        if (cmd.includes('gh auth token')) return 'gho_fallback_token\n';
        throw new Error('not stubbed');
      };
      const res = await runMain('land', '5');
      expect(res.exited).toBe(false);
      expect(logged()).toContain('Landed PR #77');
    });
  });
});

// ===========================================================================
describe('shipIssue (direct)', () => {
  const ctx = () => ({ repoRoot: h.repoRoot, ghRepo: h.ghRepo });

  it('returns the branch on the happy path and logs a ready event', async () => {
    const branch = await shipIssue(5, {}, ctx());
    expect(branch).toBe('ship-it/5-fix-the-bug');
    const events = readFileSync(paths().events, 'utf-8');
    expect(events).toContain('ready');
    expect(events).toContain('worktree');
  });

  it('logs an issue-title event with the fetched title before any other events', async () => {
    await shipIssue(5, {}, ctx());
    const events = readFileSync(paths().events, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(events[0]).toMatchObject({ type: 'issue-title', issue: '5', msg: 'Fix the bug' });
  });

  it('logs model-override events when overrides are pinned', async () => {
    h.modelOverrides = { plan: 'plan-x', build: 'build-y' };
    await shipIssue(5, {}, ctx());
    const events = readFileSync(paths().events, 'utf-8');
    expect(events).toContain('plan-x');
    expect(events).toContain('build-y');
  });

  it('logs standards source when a repo constitution resolves', async () => {
    h.constitutionResolve = () => ({ source: 'repo', product: 'alpha' });
    await shipIssue(5, { product: 'alpha' }, ctx());
    const events = readFileSync(paths().events, 'utf-8');
    expect(events).toContain('Standards from repo instruction files');
  });

  it('logs bundled standards source when a bundled constitution resolves', async () => {
    h.constitutionResolve = () => ({ source: 'bundled', product: 'beta' });
    await shipIssue(5, {}, ctx());
    const events = readFileSync(paths().events, 'utf-8');
    expect(events).toContain("bundled constitution 'beta'");
  });

  it('throws a LaneParkError with reason escalate when the plan escalates', async () => {
    h.planResult = { ok: false, route: 'claude', escalate: 'needs human' };
    await expect(shipIssue(5, {}, ctx())).rejects.toMatchObject({ reason: 'escalate' });
  });

  it('emits exactly one escalate event for the issue outside local-only mode', async () => {
    h.planResult = { ok: false, route: 'claude', escalate: 'needs human' };
    await expect(shipIssue(5, {}, ctx())).rejects.toMatchObject({ reason: 'escalate' });
    const events = readFileSync(paths().events, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const escalateEvents = events.filter((e: any) => e.type === 'escalate' && e.issue === '5');
    expect(escalateEvents).toHaveLength(1);
  });

  it('throws a LaneParkError with reason escalate when the build escalates', async () => {
    h.buildResult = { ok: false, escalate: 'stuck' };
    await expect(shipIssue(5, {}, ctx())).rejects.toMatchObject({ reason: 'escalate' });
  });

  it('throws a LaneParkError with reason fail when the ship phase fails', async () => {
    h.shipResult = { ok: false };
    await expect(shipIssue(5, {}, ctx())).rejects.toMatchObject({ reason: 'fail' });
  });

  it('throws a LaneParkError with reason escalate and the denial message when ship is denied', async () => {
    h.shipResult = { ok: false, denied: true, deniedReason: 'not today' };
    await expect(shipIssue(5, {}, ctx())).rejects.toMatchObject({
      reason: 'escalate',
      message: 'ship denied: not today',
    });
  });

  it('does not construct an approval gate when interactive is not requested', async () => {
    const core = await import('@on-par/factory-core');
    await shipIssue(5, {}, ctx());
    const call = vi.mocked(core.shipPhase).mock.calls.at(-1)?.[0] as any;
    expect(call.approvalGate).toBeUndefined();
    expect(call.checkSummary).toBe(h.checkResult.summary);
  });

  it('constructs an approval gate when interactive:true is passed', async () => {
    const core = await import('@on-par/factory-core');
    await shipIssue(5, { interactive: true }, ctx());
    const call = vi.mocked(core.shipPhase).mock.calls.at(-1)?.[0] as any;
    expect(typeof call.approvalGate).toBe('function');
  });

  it('does not construct a plan approval gate when approvePlan is not requested', async () => {
    const core = await import('@on-par/factory-core');
    await shipIssue(5, {}, ctx());
    const call = vi.mocked(core.planPhase).mock.calls.at(-1)?.[0] as any;
    expect(call.approvalGate).toBeUndefined();
    expect(call.drainSteering).toBeUndefined();
  });

  it('constructs a plan approval gate when approvePlan:true is passed', async () => {
    const core = await import('@on-par/factory-core');
    await shipIssue(5, { approvePlan: true }, ctx());
    const call = vi.mocked(core.planPhase).mock.calls.at(-1)?.[0] as any;
    expect(typeof call.approvalGate).toBe('function');
    expect(typeof call.drainSteering).toBe('function');

    mkdirSync(paths().steering, { recursive: true });
    writeFileSync(
      join(paths().steering, 'issue-5.ndjson'),
      `${JSON.stringify({ id: 'steer-3', issue: 5, text: 'use provider X', queuedAt: '2026-01-01T00:00:00.000Z' })}\n`,
    );
    const drained = call.drainSteering();
    expect(drained.messages).toEqual([
      { id: 'steer-3', issue: 5, text: 'use provider X', queuedAt: '2026-01-01T00:00:00.000Z' },
    ]);
  });

  it('passes an onPgid callback to buildPhase and checkPhase', async () => {
    const core = await import('@on-par/factory-core');
    await shipIssue(5, {}, ctx());
    const buildCall = vi.mocked(core.buildPhase).mock.calls.at(-1)?.[0] as any;
    const checkCall = vi.mocked(core.checkPhase).mock.calls.at(-1)?.[0] as any;
    expect(typeof buildCall.onPgid).toBe('function');
    expect(typeof checkCall.onPgid).toBe('function');
  });

  it('tracks a pgid reported through onPgid and sweeps it before releasing the lease, without crashing the run', async () => {
    const core = await import('@on-par/factory-core');
    vi.mocked(core.buildPhase).mockImplementationOnce(async (opts: any) => {
      // An already-dead pgid: exercises the track -> killAll path without touching a real process group.
      opts.onPgid?.(999999999);
      return h.buildResult;
    });

    const branch = await shipIssue(5, {}, ctx());
    expect(branch).toBe('ship-it/5-fix-the-bug');
  });

  it('does not log environment_cleanup when no process groups were tracked', async () => {
    await shipIssue(5, {}, ctx());
    expect(logged()).not.toContain('environment_cleanup');
  });

  it('writes a local-only run report on success when FACTORY_LOCAL_ONLY=1', async () => {
    trackEnv('FACTORY_LOCAL_ONLY');
    process.env.FACTORY_LOCAL_ONLY = '1';
    const core = await import('@on-par/factory-core');
    await shipIssue(5, {}, ctx());
    expect(vi.mocked(core.writeLocalRunReport)).toHaveBeenCalled();
    expect(logged()).toContain('local-only report');
  });

  it('writes a failed local-only run report and logs the park reason on error', async () => {
    trackEnv('FACTORY_LOCAL_ONLY');
    process.env.FACTORY_LOCAL_ONLY = '1';
    h.checkResult = { passed: false, summary: { results: [], failures: 1 }, reworkRounds: 0 };
    const core = await import('@on-par/factory-core');
    await expect(shipIssue(5, {}, ctx())).rejects.toBeTruthy();
    const report = vi.mocked(core.writeLocalRunReport).mock.calls.at(-1)?.[0] as any;
    expect(report.outcome).toBe('failed');
  });

  it('logs sandbox-disabled by config when factory.json sandbox.enabled is false', async () => {
    h.factoryConfig = { ...h.factoryConfig, sandbox: { ...h.factoryConfig.sandbox, enabled: false } };
    await shipIssue(5, {}, ctx());
    const events = readFileSync(paths().events, 'utf-8');
    expect(events).toContain('sandbox disabled by config/FACTORY_SANDBOX');
  });

  it('activates the sandbox policy and logs the degraded-egress warning when a sandbox runtime is available', async () => {
    h.execSyncImpl = (cmd: string) => {
      if (cmd.includes('command -v sandbox-exec') || cmd.includes('command -v firejail')) return '/usr/bin/tool';
      throw new Error('not stubbed');
    };
    await shipIssue(5, {}, ctx());
    const events = readFileSync(paths().events, 'utf-8');
    expect(events).toContain('sandbox-degraded');
    expect(events).toContain('host-level egress filtering unavailable');
    expect(events).not.toContain('sandbox-unavailable');
  });

  it('logs skip-ci when FACTORY_SKIP_CI resolves to true', async () => {
    const core = await import('@on-par/factory-core');
    vi.mocked(core.resolveSkipCI).mockReturnValueOnce(true);
    await shipIssue(5, {}, ctx());
    const events = readFileSync(paths().events, 'utf-8');
    expect(events).toContain('skip-ci');
    expect(events).toContain('skipping CI watch');
  });

  it('logs unconsumed steering when interactive leftover messages remain after ship', async () => {
    // Queue a fresh steering message as a side effect of shipPhase — after the
    // build-time drain but before shipIssue's post-ship leftover check.
    const core = await import('@on-par/factory-core');
    vi.mocked(core.shipPhase).mockImplementationOnce(async () => {
      mkdirSync(paths().steering, { recursive: true });
      writeFileSync(
        join(paths().steering, 'issue-5.ndjson'),
        `${JSON.stringify({ id: 'steer-late', issue: 5, text: 'too late', queuedAt: '2026-01-01T00:00:00.000Z' })}\n`,
      );
      return h.shipResult;
    });
    await shipIssue(5, { interactive: true }, ctx());
    const events = readFileSync(paths().events, 'utf-8');
    expect(events).toContain('steering_unconsumed');
  });

  describe('steering', () => {
    function writeQueuedSteering() {
      mkdirSync(paths().steering, { recursive: true });
      writeFileSync(
        join(paths().steering, 'issue-5.ndjson'),
        `${JSON.stringify({ id: 'steer-1', issue: 5, text: 'prefer approach B', queuedAt: '2026-01-01T00:00:00.000Z' })}\n`,
      );
    }

    it('drains queued steering into buildPhase and logs steering_applied when interactive', async () => {
      writeQueuedSteering();
      const core = await import('@on-par/factory-core');

      await shipIssue(5, { interactive: true }, ctx());

      const buildCall = vi.mocked(core.buildPhase).mock.calls.at(-1)?.[0] as any;
      expect(buildCall.steering.messages).toEqual([
        { id: 'steer-1', issue: 5, text: 'prefer approach B', queuedAt: '2026-01-01T00:00:00.000Z' },
      ]);
      const events = readFileSync(paths().events, 'utf-8');
      expect(events).toContain('steering_applied');
      expect(existsSync(join(paths().steering, 'issue-5.ndjson'))).toBe(false);
    });

    it('passes a drainSteering callback to checkPhase that drains the same issue steering queue', async () => {
      const core = await import('@on-par/factory-core');

      await shipIssue(5, { interactive: true }, ctx());

      const checkCall = vi.mocked(core.checkPhase).mock.calls.at(-1)?.[0] as any;
      expect(typeof checkCall.drainSteering).toBe('function');

      mkdirSync(paths().steering, { recursive: true });
      writeFileSync(
        join(paths().steering, 'issue-5.ndjson'),
        `${JSON.stringify({ id: 'steer-2', issue: 5, text: 'follow up guidance', queuedAt: '2026-01-01T00:00:00.000Z' })}\n`,
      );

      const drained = checkCall.drainSteering();
      expect(drained.messages).toEqual([
        { id: 'steer-2', issue: 5, text: 'follow up guidance', queuedAt: '2026-01-01T00:00:00.000Z' },
      ]);
    });

    it('does not drain steering, and passes steering: undefined, when not interactive', async () => {
      writeQueuedSteering();
      const core = await import('@on-par/factory-core');

      await shipIssue(5, {}, ctx());

      const buildCall = vi.mocked(core.buildPhase).mock.calls.at(-1)?.[0] as any;
      expect(buildCall.steering).toBeUndefined();
      const checkCall = vi.mocked(core.checkPhase).mock.calls.at(-1)?.[0] as any;
      expect(checkCall.drainSteering).toBeUndefined();
      expect(existsSync(join(paths().steering, 'issue-5.ndjson'))).toBe(true);
      const events = readFileSync(paths().events, 'utf-8');
      expect(events).not.toContain('steering_applied');
    });
  });
});

// ===========================================================================
describe('CliExitError (direct command invocation)', () => {
  it('is a proper Error subclass carrying a code', () => {
    const err = new CliExitError('msg', 3);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('CliExitError');
    expect(err.message).toBe('msg');
    expect(err.code).toBe(3);
  });

  it('cmdConstitution({}) rejects with code 2 and the usage message', async () => {
    await expect(cmdConstitution({})).rejects.toMatchObject({
      name: 'CliExitError',
      code: 2,
      message: expect.stringContaining('usage: factory constitution'),
    });
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("cmdConstitution({ product: 'nope' }) rejects with code 1 and the not-found message", async () => {
    await expect(cmdConstitution({ product: 'nope' })).rejects.toMatchObject({
      name: 'CliExitError',
      code: 1,
      message: expect.stringContaining("No constitution 'nope'"),
    });
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('cmdUsage() rejects with code 2 when FACTORY_USAGE_CAP is invalid', async () => {
    trackEnv('FACTORY_USAGE_CAP');
    process.env.FACTORY_USAGE_CAP = '-5';
    await expect(cmdUsage()).rejects.toMatchObject({
      name: 'CliExitError',
      code: 2,
      message: expect.stringContaining('FACTORY_USAGE_CAP'),
    });
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('cmdUsage() prints the real subscription usage plus the heuristic comparison when the subscription signal is available', async () => {
    h.subscriptionUsage = { fiveHourUtilization: 42, fiveHourResetsAt: '2026-07-15T18:00:00Z' };
    await cmdUsage();
    const logged = logSpy.mock.calls.map((c: any[]) => c[0]).join('\n');
    expect(logged).toContain('5h subscription usage: 42% of plan limit, resets 2026-07-15T18:00:00Z');
    expect(logged).toContain('heuristic list-price estimate: USAGE REPORT');
  });

  it('cmdUsage() falls back to the heuristic with a warning when the subscription signal is unavailable', async () => {
    h.subscriptionUsage = null;
    await cmdUsage();
    const logged = logSpy.mock.calls.map((c: any[]) => c[0]).join('\n');
    expect(logged).toContain('real subscription usage unavailable');
    expect(logged).toContain('USAGE REPORT');
  });

  it('cmdLand(5) rejects with code 1 when there is no open PR', async () => {
    h.octokit.rest.pulls.list = vi.fn(async () => ({ data: [] }));
    await expect(cmdLand(5)).rejects.toMatchObject({
      name: 'CliExitError',
      code: 1,
      message: expect.stringContaining('no open PR'),
    });
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('cmdLand(5) resolves cleanly and leaves the PR open when the merge is blocked on a required review', async () => {
    h.octokit.graphql = vi.fn(async (query: string) =>
      query.trimStart().startsWith('query')
        ? {
            repository: {
              pullRequest: {
                id: 'PR_1',
                isDraft: false,
                mergeStateStatus: 'BLOCKED',
                reviewDecision: 'REVIEW_REQUIRED',
              },
            },
          }
        : {},
    );
    h.octokit.rest.pulls.merge = vi.fn(async () => {
      throw new Error('At least 1 approving review is required by reviewers with write access.');
    });

    await expect(cmdLand(5)).resolves.toBeUndefined();

    expect(logged()).toContain('awaiting human review');
    expect(cleanupWorktree).toHaveBeenCalled();

    const events = readFileSync(paths().events, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(events.some((e) => e.type === 'awaiting-review')).toBe(true);
  });
});

// ===========================================================================
describe('parseIssueArg', () => {
  it('returns the parsed number for a valid issue argument', () => {
    expect(parseIssueArg('123')).toBe(123);
  });

  it('trims surrounding whitespace before parsing', () => {
    expect(parseIssueArg(' 42 ')).toBe(42);
  });

  it.each(['abc', '', '12abc', '1.5', '-3', '0', '#123'])(
    "throws CliExitError(2) naming the invalid argument for '%s'",
    (raw) => {
      expect(() => parseIssueArg(raw)).toThrowError(CliExitError);
      try {
        parseIssueArg(raw);
        expect.fail('expected parseIssueArg to throw');
      } catch (err) {
        expect(err).toMatchObject({
          name: 'CliExitError',
          code: 2,
          message: expect.stringContaining(`'${raw}'`),
        });
      }
    },
  );
});

// ===========================================================================
describe('parseIssueArg wired into ship/land/local-small-dry-run', () => {
  it.each(['ship', 'land', 'local-small-dry-run'])(
    "'%s abc' fails before any GitHub or git work runs",
    async (command) => {
      const res = await runMain(command, 'abc');
      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain("invalid issue argument 'abc'");
      expect(h.octokit.rest.issues.get).not.toHaveBeenCalled();
      expect(h.octokit.rest.pulls.list).not.toHaveBeenCalled();
    },
  );
});
