// packages/cli/src/cli/test-support/ship-harness.ts — shared scaffolding for the shipIssue (direct) tests (#2789)
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, beforeEach, vi } from 'vitest';

import { type CliDeps, main, shipIssue as cliShipIssue } from '../index.js';

const tmp = createTempDirs();

// ---------------------------------------------------------------------------
// Shared mutable state the fakes read from. Reset per test by installShipHarness().
// ---------------------------------------------------------------------------
export const h = {
  repoRoot: '',
  constitutionsDir: '',
  ghRepo: 'on-par/software-factory',
  // shell seam (CliDeps.exec / execSync)
  execImpl: (_cmd: string): string => '',
  execSyncImpl: (_cmd: string): string => {
    throw new Error('execSync not stubbed');
  },
  claudeAvailable: undefined as boolean | undefined,
  dockerAvailable: undefined as boolean | undefined,
  sbxAvailable: undefined as boolean | undefined,
  // GitHub client injected through CliDeps.octokit
  octokit: {} as any,
  // configurable core behaviour
  constitutionResolve: (
    _worktree: string,
    _product?: string,
    _constitutionPath?: string,
    _mainCheckoutDir?: string,
  ): any => null,
  modelOverrides: {} as Record<string, string>,
  modelProviders: {} as Record<string, string>,
  triageCandidates: [] as string[],
  routerRun: (async (_task: string, _prompt: string, _opts?: any) => {
    throw new Error('router.run not scripted');
  }) as (task: string, prompt: string, opts?: any) => Promise<{ model: string; output: string }>,
  triggerPlanProviderFailure: null as { provider: string; reason: any; detail?: string } | null,
  planResult: { ok: true, route: 'claude' } as any,
  buildResult: { ok: true } as any,
  checkResult: { passed: true, summary: { results: [], failures: 0 }, reworkRounds: 0 } as any,
  orphanEvents: [] as any[],
  portListeners: [] as any[],
  shipResult: { ok: true, prNumber: 99 } as any,
  diagnoses: [] as any[],
  harnessProbes: [] as any[],
  costs: [] as any[],
  gcReport: { removed: [], kept: 0, dryRun: false } as any,
  shipReap: { outcome: 'removed', branch: 'factory/5-fix-the-bug', branchDeleted: true } as any,
  costSinkCallback: undefined as ((entry: any) => void) | undefined,
  trailingSpend: 10,
  subscriptionUsage: null as { fiveHourUtilization: number; fiveHourResetsAt: string | null } | null,
  routerResolve: (_route: string): string | undefined => 'claude-model',
  factoryConfig: {
    merge: { auto: false, comment: '' },
    worktree: { parent: '../', gcTtlDays: 7, autoGcOnRun: false },
    sandbox: {
      enabled: true,
      codexFullAccessTasks: [],
      network: { allow: ['api.anthropic.com', 'github.com'] },
      resources: { cpuMs: 300_000, memMb: 4096 },
    },
    sweep: { loopIntervalSeconds: 300, staleThresholdMultiplier: 2 },
  } as any,
  setupWorktreeImpl: async (_repoRoot: string, _branch: string, _worktree: string, _startPoint?: string) => {},
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
export class ExitError extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

let exitSpy: any;
let logSpy: any;
let errSpy: any;

export const savedEnv: Record<string, string | undefined> = {};

export function trackEnv(...keys: string[]) {
  for (const k of keys) savedEnv[k] = process.env[k];
}

export function paths() {
  const root = join(h.repoRoot, '.factory');
  const state = join(root, 'state');
  return {
    root,
    state,
    queue: join(state, 'queue'),
    queueProposed: join(state, 'queue.proposed'),
    events: join(state, 'events.ndjson'),
    plans: join(state, 'plans'),
    product: join(state, 'product'),
    stop: join(state, 'STOP'),
    costs: join(state, 'costs.jsonl'),
    reports: join(state, 'reports'),
    runs: join(state, 'runs'),
    steering: join(state, 'steering'),
    kpiHistory: join(state, 'kpi-history.jsonl'),
    classifierOutcomes: join(state, 'classifier-outcomes.jsonl'),
    breaker: join(state, 'breaker.json'),
    baseHold: join(state, 'base-hold.json'),
    runFlags: join(state, 'run-flags.json'),
    mergeLock: join(state, 'merge.lock'),
    gitLock: join(state, 'git.lock'),
    config: join(root, 'config.json'),
    constitution: join(root, 'constitution.md'),
    gitignore: join(root, '.gitignore'),
  };
}

export function defaultOctokit() {
  return {
    rest: {
      issues: {
        get: vi.fn(async () => ({ data: { title: 'Fix the bug' } })),
        listForRepo: vi.fn(async () => ({ data: [] })),
        listLabelsOnIssue: vi.fn(async () => ({ data: [] })),
        listComments: vi.fn(async () => ({ data: [] })),
      },
      users: { getAuthenticated: vi.fn(async () => ({ data: { id: 7 } })) },
      rateLimit: { get: vi.fn(async () => ({ data: { resources: { core: { limit: 5000, remaining: 5000 } } } })) },
      pulls: {
        list: vi.fn(async ({ state }: any) =>
          state === 'open'
            ? { data: [{ number: 77, head: { ref: 'ship-it/5-fix-the-bug' }, body: 'Closes #5' }] }
            : { data: [] },
        ),
        get: vi.fn(async () => ({ data: { head: { sha: 'abc123' } } })),
        merge: vi.fn(async () => ({})),
      },
      git: { deleteRef: vi.fn(async () => ({})) },
      checks: { listForRef: vi.fn(async () => ({ data: { check_runs: [] } })) },
      search: { issuesAndPullRequests: vi.fn(async () => ({ data: { items: [] } })) },
    },
    graphql: vi.fn(async (query: string) =>
      query.trimStart().startsWith('query')
        ? { repository: { pullRequest: { id: 'PR_ID', isDraft: false, mergeStateStatus: 'CLEAN' } } }
        : {},
    ),
  };
}

/** Inert config loaders injected through the CliDeps seams (#2064, #2065). */
export const inertConfigLoaders: Pick<
  CliDeps,
  | 'loadModelsConfig'
  | 'loadRoutesConfig'
  | 'loadFactoryConfigForRepo'
  | 'resolveTimeouts'
  | 'resolveSkipCI'
  | 'getConstitutionsDir'
  | 'resolveEffectiveModelPins'
> = {
  loadModelsConfig: () => ({ models: {}, tiers: {} }) as never,
  loadRoutesConfig: () => ({}) as never,
  // Lazy: per-test h.factoryConfig mutations are observed.
  loadFactoryConfigForRepo: () => h.factoryConfig,
  resolveTimeouts: () => ({ plan: 1, build: 1, check: 1, approval: 1, tests: 1, compile: 1 }),
  resolveSkipCI: () => false,
  // Lazy: per-test h.constitutionsDir / h.modelOverrides mutations are observed.
  getConstitutionsDir: vi.fn(() => h.constitutionsDir),
  resolveEffectiveModelPins: vi.fn(() => ({
    plan: h.modelOverrides.plan,
    planFallback: h.modelOverrides.planFallback,
    build: h.modelOverrides.build,
    buildFallback: h.modelOverrides.buildFallback,
    sources: {},
  })) as never,
};

/** Git side-effect doubles injected through the CliDeps seams (#2019). setupWorktree delegates to h.setupWorktreeImpl. */
export const setupWorktree = vi.fn<NonNullable<CliDeps['setupWorktree']>>(async (...args) => {
  await h.setupWorktreeImpl(args[0], args[1], args[2], args[3]);
  return undefined as never;
});
const cleanupWorktree = vi.fn(async (..._args: Parameters<NonNullable<CliDeps['cleanupWorktree']>>) => {});
const gitFetch = vi.fn(async (_repoRoot: string) => {});
const inertGitOps: Pick<CliDeps, 'setupWorktree' | 'cleanupWorktree' | 'gitFetch'> = {
  setupWorktree,
  cleanupWorktree,
  gitFetch,
};

function makeInternalFakes() {
  return {
    readCosts: vi.fn(() => h.costs) as any,
    sweepWorktrees: vi.fn(async () => h.gcReport) as any,
    reapCleanShipWorktree: vi.fn(async () => h.shipReap) as any,
    formatGcReport: vi.fn(
      (report: any) =>
        `GC_REPORT:${report.dryRun ? 'dry' : 'real'}:removed=${report.removed.length}:kept=${report.kept}`,
    ),
    exec: vi.fn(async (cmd: string) => ({ stdout: h.execImpl(cmd), stderr: '' })),
    execSync: vi.fn((cmd: string) => h.execSyncImpl(cmd)),
    octokit: () => h.octokit,
  } satisfies Pick<
    CliDeps,
    'readCosts' | 'sweepWorktrees' | 'reapCleanShipWorktree' | 'formatGcReport' | 'exec' | 'execSync' | 'octokit'
  >;
}
/** Fresh fakes per test, spread into every main/shipIssue call. */
export let ops = makeInternalFakes();

function makeCoreFakes() {
  return {
    isCommandAvailable: vi.fn((cmd: string) => {
      if (cmd === 'docker') return h.dockerAvailable ?? false;
      if (cmd === 'sbx') return h.sbxAvailable ?? false;
      return h.claudeAvailable ?? true;
    }),
    defaultFindPortListeners: vi.fn(async () => h.portListeners) as any,
    reapOrphanProcesses: vi.fn(async (opts: any) => {
      for (const e of h.orphanEvents) opts.onEvent?.(e);
      return h.orphanEvents;
    }) as any,
    // Router / loaders as light stubs.
    ModelRouter: vi.fn(function () {
      return {
        resolve: (route: string) => h.routerResolve(route),
        resolveAll: (_route: string) => h.triageCandidates,
        registryRef: {
          getClaudeFlag: () => '--flag',
          getModelsInTier: () => ['m'],
          get: (id: string) => (h.modelProviders[id] ? { provider: h.modelProviders[id] } : undefined),
          getHarnessId: (id: string) => (h.modelProviders[id] === 'anthropic' ? 'claude-cli' : 'codex-cli'),
          isCodexModel: (id: string) => h.modelProviders[id] === 'openai',
          getHarnessDeclaration: () => undefined,
          isAgenticHarnessId: () => true,
          ridesCommandRoute: () => false,
        },
        setCostSink: vi.fn((sink: (entry: any) => void) => {
          h.costSinkCallback = sink;
        }),
        setCodexFullAccessTasks: vi.fn(),
        skipMissingHarnessClis: vi.fn(),
        run: vi.fn(async (task: string, prompt: string, opts: any) => h.routerRun(task, prompt, opts)),
      };
    }) as any,
    ConstitutionLoader: vi.fn(function () {
      return {
        listProducts: () => ['alpha', 'beta'],
        load: (p: string) => ({ product: p, checkers: p === 'alpha' ? ['compile', 'lint'] : [] }),
        resolve: (...args: any[]) => (h.constitutionResolve as (...a: any[]) => any)(...args),
      };
    }) as any,
    ModelRegistry: vi.fn(function () {
      return {
        list: () => ['claude-model'],
        getTiers: () => ['worker'],
        estimateCost: () => ({ cost: 1.23, cachedRateMissing: false }),
        isExperimental: () => false,
        isAvailable: () => true,
        getModelsInTier: () => ['claude-model'],
      };
    }) as any,
    // Usage / reports.
    estimateTrailingSpend: vi.fn(() => h.trailingSpend) as any,
    formatUsageReport: vi.fn(() => 'USAGE REPORT'),
    watchUsage: vi.fn(async () => {}) as any,
    fetchSubscriptionUsage: vi.fn(async () => h.subscriptionUsage) as any,
    diagnoseModels: vi.fn(() => h.diagnoses) as any,
    probeDeclaredHarnesses: vi.fn(() => h.harnessProbes) as any,
    writeLocalRunReport: vi.fn(async () => ({ path: '/tmp/report.md' })) as any,
  } satisfies Pick<
    CliDeps,
    | 'ModelRouter'
    | 'ConstitutionLoader'
    | 'ModelRegistry'
    | 'isCommandAvailable'
    | 'defaultFindPortListeners'
    | 'reapOrphanProcesses'
    | 'estimateTrailingSpend'
    | 'formatUsageReport'
    | 'watchUsage'
    | 'fetchSubscriptionUsage'
    | 'diagnoseModels'
    | 'probeDeclaredHarnesses'
    | 'writeLocalRunReport'
  >;
}
/** Fresh fakes per test, spread into every main/shipIssue call. */
export let coreFakes = makeCoreFakes();

/**
 * Phase doubles. shipIssue builds ports and calls the real runIssue in @on-par/factory-core, which sequences
 * PLAN->BUILD->CHECK->SHIP, the breaker, budget assertions and constitution logging (#675). Only the four
 * phase functions are doubled, and they reach RunPorts through CliDeps phase overrides (ADR-0004).
 */
function makePhaseFakes() {
  return {
    planPhase: vi.fn<NonNullable<CliDeps['planPhase']>>(async (opts) => {
      if (h.triggerPlanProviderFailure) await opts.onProviderFailure?.(h.triggerPlanProviderFailure);
      return h.planResult;
    }),
    buildPhase: vi.fn<NonNullable<CliDeps['buildPhase']>>(async (_opts) => h.buildResult),
    checkPhase: vi.fn<NonNullable<CliDeps['checkPhase']>>(async (opts) => {
      for (const s of h.checkResult.summary.results.filter((r: any) => r.result === 'SKIP')) {
        opts.log?.('check', `SKIPPED: ${s.checker} — ${s.details}`);
      }
      for (let i = 0; i < (h.checkResult.reworkRounds ?? 0); i++) {
        opts.log?.('rework', `rework round ${i + 1}`);
      }
      h.costSinkCallback?.({ task: 'build', model: 'claude-model', inputTokens: 10, outputTokens: 5, cost: 0.02 });
      return h.checkResult;
    }),
    shipPhase: vi.fn<NonNullable<CliDeps['shipPhase']>>(async (_opts) => h.shipResult),
    checkBaseHealth: vi.fn<NonNullable<CliDeps['checkBaseHealth']>>(async () => ({
      kind: 'skipped' as const,
      failingChecks: [],
      cached: false,
    })),
  } satisfies Pick<CliDeps, 'planPhase' | 'buildPhase' | 'checkPhase' | 'shipPhase' | 'checkBaseHealth'>;
}
/** Fresh phase doubles per test, spread into every main/shipIssue call (CliDeps phase overrides). */
export let phases = makePhaseFakes();

/** Direct shipIssue calls get the inert models/routes loaders unless a test passes its own. */
export function shipIssue(...[issueNum, opts, ctx, deps]: Parameters<typeof cliShipIssue>) {
  return cliShipIssue(issueNum, opts, ctx, {
    ...inertConfigLoaders,
    ...inertGitOps,
    ...coreFakes,
    ...ops,
    ...phases,
    ...deps,
  });
}

export async function runMainWith(deps: CliDeps | undefined, ...args: string[]) {
  return runMainRaw({ ...inertConfigLoaders, ...deps }, ...args);
}

async function runMainRaw(deps: CliDeps | undefined, ...args: string[]) {
  try {
    await main(['node', 'factory', ...args], { ...inertGitOps, ...coreFakes, ...ops, ...phases, ...deps });
  } catch (err) {
    if (err instanceof ExitError) return { exited: true as const, code: err.code };
    throw err;
  }
  const code = process.exitCode as number | undefined;
  process.exitCode = undefined;
  return code === undefined ? { exited: false as const, code: undefined } : { exited: true as const, code };
}

export function logged(): string {
  return logSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');
}

export function errored(): string {
  return errSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');
}

/** Registers the per-test reset of h, fakes, temp dirs, env tracking and console/process.exit spies. */
export function installShipHarness(): void {
  beforeEach(() => {
    ops = makeInternalFakes();
    coreFakes = makeCoreFakes();
    phases = makePhaseFakes();
    h.repoRoot = tmp.makeSync('factory-cli-');
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
    h.modelProviders = {};
    h.triageCandidates = [];
    h.routerRun = async () => {
      throw new Error('router.run not scripted');
    };
    h.triggerPlanProviderFailure = null;
    h.planResult = { ok: true, route: 'claude' };
    h.buildResult = { ok: true };
    h.checkResult = { passed: true, summary: { results: [], failures: 0 }, reworkRounds: 0 };
    h.shipResult = { ok: true, prNumber: 99 };
    h.diagnoses = [];
    h.harnessProbes = [];
    h.costs = [];
    h.gcReport = { removed: [], kept: 0, dryRun: false };
    h.shipReap = { outcome: 'removed', branch: 'factory/5-fix-the-bug', branchDeleted: true };
    h.trailingSpend = 10;
    h.subscriptionUsage = null;
    h.routerResolve = () => 'claude-model';
    h.factoryConfig = {
      merge: { auto: false, comment: '' },
      worktree: { parent: '../', gcTtlDays: 7, autoGcOnRun: false },
      sandbox: {
        enabled: true,
        codexFullAccessTasks: [],
        network: { allow: ['api.anthropic.com', 'github.com'] },
        resources: { cpuMs: 300_000, memMb: 4096 },
      },
      sweep: { loopIntervalSeconds: 300, staleThresholdMultiplier: 2 },
      // Off by default: the guard reads the real os.loadavg(), so a busy host (load5 > 3x CPUs) held remote lanes
      // and timed tests out. Load-guard tests turn it on explicitly.
      host: { loadGuard: { enabled: false, retrySeconds: 1 } },
    };
    h.setupWorktreeImpl = async () => {};
    h.claudeAvailable = undefined;
    h.dockerAvailable = undefined;
    h.sbxAvailable = undefined;
    h.orphanEvents = [];
    h.portListeners = [];

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
      'FACTORY_SANDBOX_RUNTIME',
      'FACTORY_PLAN_MODEL',
      'FACTORY_BUILD_MODEL',
      'FACTORY_AUTO_FAILOVER',
      'FACTORY_FAILOVER_COOLDOWN_MINUTES',
      'FACTORY_FAILOVER_MODEL',
      'GITHUB_TOKEN',
      'GH_TOKEN',
      'TMUX',
      'ANTHROPIC_API_KEY',
      'CLAUDE_CONFIG_DIR',
      'CLAUDE_SECURESTORAGE_CONFIG_DIR',
    ].forEach((k) => trackEnv(k));
    // `factory run` and `factory supervise` probe the macOS login keychain before
    // claiming work, and abort when the probe fails inside tmux (#1014). The probe's
    // outcome depends on these ambient variables, so a suite launched from a tmux
    // pane on the Mini (the factory's own lanes, or a developer shell) aborted every
    // run/supervise test while the same suite passed on Linux CI and outside tmux.
    // The keychain preflight tests set them explicitly; everything else must not
    // inherit them from the host.
    delete process.env.TMUX;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
    delete process.env.FACTORY_LOCAL_ONLY;
    delete process.env.FACTORY_MERGE;
    delete process.env.FACTORY_MERGE_ADMIN;
    delete process.env.FACTORY_SANDBOX;
    delete process.env.FACTORY_SANDBOX_RUNTIME;
    delete process.env.FACTORY_USAGE_WATCH;
    delete process.env.FACTORY_PLAN_MODEL;
    delete process.env.FACTORY_BUILD_MODEL;
    delete process.env.FACTORY_AUTO_FAILOVER;
    delete process.env.FACTORY_FAILOVER_COOLDOWN_MINUTES;
    delete process.env.FACTORY_FAILOVER_MODEL;
    delete process.env.GITHUB_TOKEN;
    process.env.GH_TOKEN = 'test-token';
    process.exitCode = undefined;

    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ExitError(code ?? 0);
    }) as any);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    await tmp.cleanup();
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
}
